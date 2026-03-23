const { URL } = require('url');
const https = require('https');
const http = require('http');

const cLogger = C.util.getLogger('func:custom_api_lookup');

exports.name = 'Custom API Lookup';
exports.version = '0.1';
exports.group = 'Standard';

// Configuration state
let apiUrl = '';
let apiKey = '';
let authType = 'header';   // header, bearer, query, basic, none
let authHeaderName = 'Authorization';
let lookupField = 'ip';
let enrichPrefix = 'enrichment_';
let requestMethod = 'GET';
let requestTimeout = 5000;
let bodyTemplate = '';
let responseMode = 'merge_fields';  // merge_fields, store_raw, selective
let selectedFields = [];
let fieldMapping = {};
let batchMode = false;
let batchSize = 10;
let batchField = '';
let rateLimitMs = 0;
let lastRequestTime = 0;
let cacheTTL = 0;
let cache = new Map();
let cacheTimestamps = new Map();
let staticHeaders = {};

exports.init = (opts) => {
  const conf = opts.conf || {};

  // Required
  apiUrl = conf.apiUrl || '';
  apiKey = conf.apiKey || '';

  // Authentication
  authType = conf.authType || 'header';
  authHeaderName = conf.authHeaderName || 'Authorization';

  // Lookup configuration
  lookupField = conf.lookupField || 'ip';
  enrichPrefix = conf.enrichPrefix || 'enrichment_';
  requestMethod = (conf.requestMethod || 'GET').toUpperCase();
  requestTimeout = parseInt(conf.requestTimeout, 10) || 5000;
  bodyTemplate = conf.bodyTemplate || '';

  // Response handling
  responseMode = conf.responseMode || 'merge_fields';
  selectedFields = conf.selectedFields || [];
  fieldMapping = {};
  if (conf.fieldMappings && Array.isArray(conf.fieldMappings)) {
    for (const m of conf.fieldMappings) {
      if (m.src && m.dst) fieldMapping[m.src] = m.dst;
    }
  }

  // Batching
  batchMode = !!conf.batchMode;
  batchSize = parseInt(conf.batchSize, 10) || 10;
  batchField = conf.batchField || '';

  // Rate limiting & caching
  rateLimitMs = parseInt(conf.rateLimitMs, 10) || 0;
  lastRequestTime = 0;
  cacheTTL = parseInt(conf.cacheTTL, 10) || 0;
  cache = new Map();
  cacheTimestamps = new Map();

  // Static headers
  staticHeaders = {};
  if (conf.staticHeaders && Array.isArray(conf.staticHeaders)) {
    for (const h of conf.staticHeaders) {
      if (h.name && h.value) staticHeaders[h.name] = h.value;
    }
  }

  cLogger.info(`Custom API Lookup initialized: url=${apiUrl}, method=${requestMethod}, field=${lookupField}, auth=${authType}`);
};

/**
 * Build the full URL for a lookup value
 */
function buildUrl(lookupValue) {
  let url = apiUrl.replace(/\{\{value\}\}/g, encodeURIComponent(lookupValue));
  if (url === apiUrl && requestMethod === 'GET' && !url.includes('{{')) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}q=${encodeURIComponent(lookupValue)}`;
  }
  return url;
}

/**
 * Build request headers including authentication
 */
function buildHeaders() {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...staticHeaders,
  };

  switch (authType) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'header':
      headers[authHeaderName] = apiKey;
      break;
    case 'basic':
      headers['Authorization'] = `Basic ${Buffer.from(apiKey).toString('base64')}`;
      break;
    case 'query':
      break;
    case 'none':
    default:
      break;
  }

  return headers;
}

/**
 * Build request body for POST/PUT methods
 */
function buildBody(lookupValue) {
  if (!bodyTemplate) {
    return JSON.stringify({ query: lookupValue });
  }
  const body = bodyTemplate.replace(/\{\{value\}\}/g, lookupValue);
  return body;
}

/**
 * Make an HTTP/HTTPS request and return a promise resolving to parsed JSON
 */
function makeRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    if (authType === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}api_key=${encodeURIComponent(apiKey)}`;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      timeout: requestTimeout,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON response: ${e.message}`));
          }
        } else if (res.statusCode === 429) {
          reject(new Error(`Rate limited (429). Retry later.`));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${requestTimeout}ms`));
    });
    req.on('error', (e) => reject(e));

    if (body && (method === 'POST' || method === 'PUT')) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Apply rate limiting
 */
async function rateLimit() {
  if (rateLimitMs <= 0) return;
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < rateLimitMs) {
    await new Promise(r => setTimeout(r, rateLimitMs - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Check cache for a previously looked-up value
 */
function getCached(key) {
  if (cacheTTL <= 0) return null;
  const ts = cacheTimestamps.get(key);
  if (ts && (Date.now() - ts) < cacheTTL * 1000) {
    return cache.get(key);
  }
  cache.delete(key);
  cacheTimestamps.delete(key);
  return null;
}

/**
 * Store a value in the cache
 */
function setCache(key, value) {
  if (cacheTTL <= 0) return;
  cache.set(key, value);
  cacheTimestamps.set(key, Date.now());
  if (cache.size > 10000) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
    cacheTimestamps.delete(oldest);
  }
}

/**
 * Merge API response data into the event
 */
function enrichEvent(event, apiData) {
  if (!apiData || typeof apiData !== 'object') return;

  switch (responseMode) {
    case 'merge_fields':
      for (const [key, val] of Object.entries(apiData)) {
        const destKey = enrichPrefix + key;
        if (val !== null && val !== undefined) {
          event[destKey] = (typeof val === 'object') ? JSON.stringify(val) : val;
        }
      }
      break;

    case 'store_raw':
      event[enrichPrefix + 'raw'] = JSON.stringify(apiData);
      break;

    case 'selective':
      for (const field of selectedFields) {
        const srcParts = field.split('.');
        let val = apiData;
        for (const part of srcParts) {
          if (val && typeof val === 'object') val = val[part];
          else { val = undefined; break; }
        }
        if (val !== undefined) {
          const destKey = fieldMapping[field] || (enrichPrefix + field.replace(/\./g, '_'));
          event[destKey] = (typeof val === 'object') ? JSON.stringify(val) : val;
        }
      }
      break;
  }

  event[enrichPrefix + 'status'] = 'success';
  event[enrichPrefix + 'timestamp'] = new Date().toISOString();
}

/**
 * Main process function — called per event by Cribl
 * Returns a Promise for async API calls (same pattern as Nightfall pack)
 */
exports.process = (event) => {
  const lookupValue = event[lookupField];
  if (!lookupValue) {
    event[enrichPrefix + 'status'] = 'skipped';
    event[enrichPrefix + 'reason'] = `Field '${lookupField}' is empty or missing`;
    return event;
  }

  const lookupStr = String(lookupValue);

  const cached = getCached(lookupStr);
  if (cached) {
    enrichEvent(event, cached);
    event[enrichPrefix + 'cache_hit'] = true;
    return event;
  }

  const url = buildUrl(lookupStr);
  const headers = buildHeaders();
  const body = (requestMethod === 'POST' || requestMethod === 'PUT')
    ? buildBody(lookupStr)
    : null;

  return rateLimit()
    .then(() => makeRequest(url, requestMethod, headers, body))
    .then((apiData) => {
      setCache(lookupStr, apiData);
      enrichEvent(event, apiData);
      return event;
    })
    .catch((err) => {
      cLogger.error(`API lookup failed for ${lookupStr}: ${err.message}`);
      event[enrichPrefix + 'status'] = 'error';
      event[enrichPrefix + 'error'] = err.message;
      return event;
    });
};
