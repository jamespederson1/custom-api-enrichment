const http = require('http');
const https = require('https');
const { URL } = require('url');

const cLogger = C.util.getLogger('func:custom_api_lookup');

exports.name = 'Custom API Lookup';
exports.version = '0.3';
exports.group = 'Standard';

// --- Configuration state ---
let apiBaseUrl = '';
let valuePosition = 'path';
let queryParamName = 'q';
let extraQueryParams = '';
let apiKey = '';
let authType = 'none';
let authHeaderName = 'Authorization';
let lookupField = 'src_ip';
let enrichPrefix = 'geo_';
let requestMethod = 'GET';
let requestTimeout = 5000;
let bodyTemplate = '';
let responseMode = 'merge_fields';
let selectedFields = [];
let fieldMapping = {};
let rateLimitMs = 0;
let lastRequestTime = 0;
let cacheTTL = 300;
let cache = new Map();
let cacheTimestamps = new Map();
let staticHeaders = {};

exports.init = (opts) => {
  const conf = opts.conf || {};

  // URL configuration
  apiBaseUrl = (conf.apiBaseUrl || 'http://ip-api.com/json').replace(/\/+$/, '');
  valuePosition = conf.valuePosition || 'path';
  queryParamName = conf.queryParamName || 'q';
  extraQueryParams = conf.extraQueryParams || '';

  // Auth
  apiKey = conf.apiKey || '';
  authType = conf.authType || 'none';
  authHeaderName = conf.authHeaderName || 'Authorization';

  // Lookup & enrichment
  lookupField = conf.lookupField || 'src_ip';
  enrichPrefix = conf.enrichPrefix || 'geo_';
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

  // Performance
  rateLimitMs = parseInt(conf.rateLimitMs, 10) || 0;
  lastRequestTime = 0;
  cacheTTL = parseInt(conf.cacheTTL, 10) || 300;
  cache = new Map();
  cacheTimestamps = new Map();

  // Extra headers
  staticHeaders = {};
  if (conf.staticHeaders && Array.isArray(conf.staticHeaders)) {
    for (const h of conf.staticHeaders) {
      if (h.name && h.value) staticHeaders[h.name] = h.value;
    }
  }

  cLogger.info(`Custom API Lookup initialized: base=${apiBaseUrl}, valuePos=${valuePosition}, field=${lookupField}, auth=${authType}`);
};

// -------------------------------------------------------
// URL builder — constructs the full URL from config fields
// -------------------------------------------------------
// valuePosition controls how the lookup value is placed:
//   path:   GET http://ip-api.com/json/8.8.8.8?fields=...
//   query:  GET http://api.example.com/lookup?q=8.8.8.8
//   body:   POST http://api.example.com/enrich  (value goes in request body, not URL)
// -------------------------------------------------------
function buildUrl(lookupValue) {
  const encoded = encodeURIComponent(lookupValue);
  let url = apiBaseUrl;

  // Append value to URL path
  if (valuePosition === 'path') {
    url = `${url}/${encoded}`;
  }

  // Build query string
  const params = [];
  if (valuePosition === 'query') {
    params.push(`${encodeURIComponent(queryParamName)}=${encoded}`);
  }
  if (extraQueryParams) {
    params.push(extraQueryParams);
  }
  if (authType === 'query' && apiKey) {
    params.push(`api_key=${encodeURIComponent(apiKey)}`);
  }

  if (params.length > 0) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}${params.join('&')}`;
  }

  return url;
}

// --- Header builder ---
function buildHeaders() {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'CriblStream/1.0', ...staticHeaders };
  switch (authType) {
    case 'bearer': headers['Authorization'] = `Bearer ${apiKey}`; break;
    case 'header': headers[authHeaderName] = apiKey; break;
    case 'basic': headers['Authorization'] = `Basic ${Buffer.from(apiKey).toString('base64')}`; break;
    case 'query': break; // handled in buildUrl
    case 'none': default: break;
  }
  return headers;
}

// --- Body builder (POST/PUT) ---
function buildBody(lookupValue) {
  if (bodyTemplate) {
    // Replace {lookup_value} placeholder in custom body template
    return bodyTemplate.replace(/\{lookup_value\}/g, lookupValue);
  }
  return JSON.stringify({ query: lookupValue });
}

// --- HTTP request returning a Promise ---
function makeRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      timeout: requestTimeout,
    };

    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else if (res.statusCode === 429) {
          reject(new Error('Rate limited (429)'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${requestTimeout}ms`)); });
    req.on('error', (e) => reject(e));
    if (body && (method === 'POST' || method === 'PUT')) {
      headers['Content-Type'] = 'application/json';
      req.write(body);
    }
    req.end();
  });
}

// --- Rate limiting ---
async function rateLimit() {
  if (rateLimitMs <= 0) return;
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < rateLimitMs) await new Promise(r => setTimeout(r, rateLimitMs - elapsed));
  lastRequestTime = Date.now();
}

// --- Cache ---
function getCached(key) {
  if (cacheTTL <= 0) return null;
  const ts = cacheTimestamps.get(key);
  if (ts && (Date.now() - ts) < cacheTTL * 1000) return cache.get(key);
  cache.delete(key); cacheTimestamps.delete(key);
  return null;
}
function setCache(key, val) {
  if (cacheTTL <= 0) return;
  cache.set(key, val); cacheTimestamps.set(key, Date.now());
  if (cache.size > 10000) { const oldest = cache.keys().next().value; cache.delete(oldest); cacheTimestamps.delete(oldest); }
}

// --- Enrich event with API response ---
function enrichEvent(event, apiData) {
  if (!apiData || typeof apiData !== 'object') return;
  switch (responseMode) {
    case 'merge_fields':
      for (const [key, val] of Object.entries(apiData)) {
        if (val !== null && val !== undefined) {
          event[enrichPrefix + key] = (typeof val === 'object') ? JSON.stringify(val) : val;
        }
      }
      break;
    case 'store_raw':
      event[enrichPrefix + 'raw'] = JSON.stringify(apiData);
      break;
    case 'selective':
      for (const field of selectedFields) {
        const parts = field.split('.');
        let val = apiData;
        for (const p of parts) { if (val && typeof val === 'object') val = val[p]; else { val = undefined; break; } }
        if (val !== undefined) {
          const dest = fieldMapping[field] || (enrichPrefix + field.replace(/\./g, '_'));
          event[dest] = (typeof val === 'object') ? JSON.stringify(val) : val;
        }
      }
      break;
  }
  event[enrichPrefix + 'lookup_status'] = 'success';
  event[enrichPrefix + 'lookup_ts'] = new Date().toISOString();
}

// --- Main: process each event (async Promise pattern) ---
exports.process = (event) => {
  const lookupValue = event[lookupField];
  if (!lookupValue) {
    event[enrichPrefix + 'lookup_status'] = 'skipped';
    event[enrichPrefix + 'lookup_reason'] = `Field '${lookupField}' is empty`;
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
  const body = (requestMethod === 'POST' || requestMethod === 'PUT') ? buildBody(lookupStr) : null;

  return rateLimit()
    .then(() => makeRequest(url, requestMethod, headers, body))
    .then((apiData) => {
      if (apiData.status === 'fail') {
        event[enrichPrefix + 'lookup_status'] = 'api_error';
        event[enrichPrefix + 'lookup_error'] = apiData.message || 'unknown';
        return event;
      }
      setCache(lookupStr, apiData);
      enrichEvent(event, apiData);
      return event;
    })
    .catch((err) => {
      cLogger.error(`API lookup failed for ${lookupStr}: ${err.message}`);
      event[enrichPrefix + 'lookup_status'] = 'error';
      event[enrichPrefix + 'lookup_error'] = err.message;
      return event;
    });
};
