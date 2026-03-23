const http = require('http');
const https = require('https');
const { URL } = require('url');

const cLogger = C.util.getLogger('func:custom_api_lookup');

exports.name = 'Custom API Lookup';
exports.version = '0.4';
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

// --- Batch mode state ---
let batchEnabled = false;
let batchSize = 10;
let batchUrl = '';
let eventBuffer = [];

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

  // Batch mode
  batchEnabled = !!conf.batchEnabled;
  batchSize = parseInt(conf.batchSize, 10) || 10;
  batchUrl = (conf.batchUrl || 'http://ip-api.com/batch').replace(/\/+$/, '');
  eventBuffer = [];

  // Extra headers
  staticHeaders = {};
  if (conf.staticHeaders && Array.isArray(conf.staticHeaders)) {
    for (const h of conf.staticHeaders) {
      if (h.name && h.value) staticHeaders[h.name] = h.value;
    }
  }

  cLogger.info(`Custom API Lookup initialized: base=${apiBaseUrl}, batch=${batchEnabled}, batchSize=${batchSize}, field=${lookupField}, auth=${authType}`);
};

// -------------------------------------------------------
// URL builder
// -------------------------------------------------------
function buildUrl(lookupValue) {
  const encoded = encodeURIComponent(lookupValue);
  let url = apiBaseUrl;

  if (valuePosition === 'path') {
    url = `${url}/${encoded}`;
  }

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
    case 'query': break;
    case 'none': default: break;
  }
  return headers;
}

// --- Body builder (POST/PUT single event) ---
function buildBody(lookupValue) {
  if (bodyTemplate) {
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

    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }

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
    if (body && (method === 'POST' || method === 'PUT')) req.write(body);
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

// --- Enrich a single event with API response data ---
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

// -------------------------------------------------------
// BATCH MODE: process a batch of buffered events in one API call
// -------------------------------------------------------
async function processBatch(batch) {
  // Separate cached vs uncached events
  const uncachedEvents = [];
  const uncachedValues = [];

  for (const ev of batch) {
    const val = String(ev[lookupField] || '');
    const cached = getCached(val);
    if (cached) {
      enrichEvent(ev, cached);
      ev[enrichPrefix + 'cache_hit'] = true;
    } else if (val) {
      uncachedEvents.push(ev);
      uncachedValues.push(val);
    } else {
      ev[enrichPrefix + 'lookup_status'] = 'skipped';
      ev[enrichPrefix + 'lookup_reason'] = `Field '${lookupField}' is empty`;
    }
  }

  // If all were cached or empty, return immediately
  if (uncachedEvents.length === 0) return batch;

  try {
    await rateLimit();

    // Build batch request body
    // ip-api.com /batch expects an array of objects: [{"query":"8.8.8.8","fields":"..."},...]
    const batchBody = uncachedValues.map(val => {
      const item = { query: val };
      if (extraQueryParams) {
        // Extract 'fields' param from extraQueryParams for ip-api.com batch format
        const fieldsMatch = extraQueryParams.match(/fields=([^&]+)/);
        if (fieldsMatch) item.fields = fieldsMatch[1];
      }
      return item;
    });

    const headers = buildHeaders();
    let url = batchUrl;
    if (extraQueryParams && !url.includes('?')) {
      // For non-ip-api batch endpoints, append extra params to URL
      const fieldsInBody = extraQueryParams.match(/fields=/);
      if (!fieldsInBody) {
        url = `${url}?${extraQueryParams}`;
      }
    }

    const data = await makeRequest(url, 'POST', headers, JSON.stringify(batchBody));

    // Match results back to events
    // ip-api.com /batch returns an array in the same order as the request
    const results = Array.isArray(data) ? data : [];
    for (let i = 0; i < uncachedEvents.length; i++) {
      const ev = uncachedEvents[i];
      const result = results[i];
      if (result) {
        if (result.status === 'fail') {
          ev[enrichPrefix + 'lookup_status'] = 'api_error';
          ev[enrichPrefix + 'lookup_error'] = result.message || 'unknown';
        } else {
          setCache(uncachedValues[i], result);
          enrichEvent(ev, result);
        }
      } else {
        ev[enrichPrefix + 'lookup_status'] = 'no_result';
      }
    }
  } catch (err) {
    cLogger.error(`Batch API lookup failed: ${err.message}`);
    for (const ev of uncachedEvents) {
      ev[enrichPrefix + 'lookup_status'] = 'error';
      ev[enrichPrefix + 'lookup_error'] = err.message;
    }
  }

  return batch;
}

// -------------------------------------------------------
// SINGLE MODE: process one event with one API call
// -------------------------------------------------------
function processSingle(event) {
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
}

// -------------------------------------------------------
// exports.process — called once per event by Cribl
// -------------------------------------------------------
exports.process = (event) => {
  // SINGLE MODE: one HTTP call per event
  if (!batchEnabled) {
    return processSingle(event);
  }

  // BATCH MODE: buffer events, fire when batch is full
  eventBuffer.push(event);
  if (eventBuffer.length < batchSize) {
    // Buffer not full yet — return null to hold the event
    // Cribl will not forward anything downstream until we return it
    return null;
  }

  // Buffer is full — process the batch
  const currentBatch = [...eventBuffer];
  eventBuffer = [];
  return processBatch(currentBatch);
};

// -------------------------------------------------------
// exports.flush — called when the stream ends or pipeline closes
// Without this, the last partial batch (< batchSize events) is DROPPED
// -------------------------------------------------------
exports.flush = () => {
  if (!batchEnabled || eventBuffer.length === 0) return null;

  const finalBatch = [...eventBuffer];
  eventBuffer = [];
  cLogger.info(`Flushing final batch of ${finalBatch.length} events`);
  return processBatch(finalBatch);
};
