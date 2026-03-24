const http = require('http');
const https = require('https');
const { URL } = require('url');

const cLogger = C.util.getLogger('func:custom_api_lookup');

exports.name = 'Custom API Lookup';
exports.version = '0.5';
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
// Shared-promise batch: each event in the batch gets a resolver
// When the batch fires, ALL resolvers are called and all events proceed
let pendingBatch = [];    // [{event, lookupStr, resolve}]
let batchTimer = null;
let batchTimeoutMs = 2000; // max ms to wait before firing a partial batch

exports.init = (opts) => {
  const conf = opts.conf || {};
  apiBaseUrl = (conf.apiBaseUrl || 'http://ip-api.com/json').replace(/\/+$/, '');
  valuePosition = conf.valuePosition || 'path';
  queryParamName = conf.queryParamName || 'q';
  extraQueryParams = conf.extraQueryParams || '';
  apiKey = conf.apiKey || '';
  authType = conf.authType || 'none';
  authHeaderName = conf.authHeaderName || 'Authorization';
  lookupField = conf.lookupField || 'src_ip';
  enrichPrefix = conf.enrichPrefix || 'geo_';
  requestMethod = (conf.requestMethod || 'GET').toUpperCase();
  requestTimeout = parseInt(conf.requestTimeout, 10) || 5000;
  bodyTemplate = conf.bodyTemplate || '';
  responseMode = conf.responseMode || 'merge_fields';
  selectedFields = conf.selectedFields || [];
  fieldMapping = {};
  if (conf.fieldMappings && Array.isArray(conf.fieldMappings)) {
    for (const m of conf.fieldMappings) { if (m.src && m.dst) fieldMapping[m.src] = m.dst; }
  }
  rateLimitMs = parseInt(conf.rateLimitMs, 10) || 0;
  lastRequestTime = 0;
  cacheTTL = parseInt(conf.cacheTTL, 10) || 300;
  cache = new Map();
  cacheTimestamps = new Map();
  batchEnabled = !!conf.batchEnabled;
  batchSize = parseInt(conf.batchSize, 10) || 10;
  batchUrl = (conf.batchUrl || 'http://ip-api.com/batch').replace(/\/+$/, '');
  batchTimeoutMs = parseInt(conf.batchTimeoutMs, 10) || 2000;
  pendingBatch = [];
  batchTimer = null;
  staticHeaders = {};
  if (conf.staticHeaders && Array.isArray(conf.staticHeaders)) {
    for (const h of conf.staticHeaders) { if (h.name && h.value) staticHeaders[h.name] = h.value; }
  }
  cLogger.info(`Custom API Lookup v0.5: base=${apiBaseUrl}, batch=${batchEnabled}, batchSize=${batchSize}, field=${lookupField}`);
};

// --- URL builder ---
function buildUrl(lookupValue) {
  const encoded = encodeURIComponent(lookupValue);
  let url = apiBaseUrl;
  if (valuePosition === 'path') url = `${url}/${encoded}`;
  const params = [];
  if (valuePosition === 'query') params.push(`${encodeURIComponent(queryParamName)}=${encoded}`);
  if (extraQueryParams) params.push(extraQueryParams);
  if (authType === 'query' && apiKey) params.push(`api_key=${encodeURIComponent(apiKey)}`);
  if (params.length > 0) { url = `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}`; }
  return url;
}

// --- Header builder ---
function buildHeaders() {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'CriblStream/1.0', ...staticHeaders };
  switch (authType) {
    case 'bearer': headers['Authorization'] = `Bearer ${apiKey}`; break;
    case 'header': headers[authHeaderName] = apiKey; break;
    case 'basic': headers['Authorization'] = `Basic ${Buffer.from(apiKey).toString('base64')}`; break;
  }
  return headers;
}

// --- Body builder ---
function buildBody(lookupValue) {
  if (bodyTemplate) return bodyTemplate.replace(/\{lookup_value\}/g, lookupValue);
  return JSON.stringify({ query: lookupValue });
}

// --- HTTP request ---
function makeRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method, headers, timeout: requestTimeout,
    };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(body); }
    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        } else { reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', (e) => reject(e));
    if (body && (method === 'POST' || method === 'PUT')) req.write(body);
    req.end();
  });
}

// --- Rate limiting ---
async function rateLimit() {
  if (rateLimitMs <= 0) return;
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < rateLimitMs) { const d = rateLimitMs - elapsed; await new Promise(r => setTimeout(r, d)); }
  lastRequestTime = Date.now();
}

// --- Cache ---
function getCached(key) {
  if (cacheTTL <= 0) return null;
  const ts = cacheTimestamps.get(key);
  if (ts && (Date.now() - ts) < cacheTTL * 1000) return cache.get(key);
  cache.delete(key); cacheTimestamps.delete(key); return null;
}
function setCache(key, val) {
  if (cacheTTL <= 0) return;
  cache.set(key, val); cacheTimestamps.set(key, Date.now());
  if (cache.size > 10000) { const k = cache.keys().next().value; cache.delete(k); cacheTimestamps.delete(k); }
}

// --- Enrich event ---
function enrichEvent(event, apiData) {
  if (!apiData || typeof apiData !== 'object') return;
  switch (responseMode) {
    case 'merge_fields':
      for (const [key, val] of Object.entries(apiData)) {
        if (val !== null && val !== undefined) event[enrichPrefix + key] = (typeof val === 'object') ? JSON.stringify(val) : val;
      }
      break;
    case 'store_raw':
      event[enrichPrefix + 'raw'] = JSON.stringify(apiData); break;
    case 'selective':
      for (const field of selectedFields) {
        const parts = field.split('.'); let val = apiData;
        for (const p of parts) { if (val && typeof val === 'object') val = val[p]; else { val = undefined; break; } }
        if (val !== undefined) { const dest = fieldMapping[field] || (enrichPrefix + field.replace(/\./g, '_')); event[dest] = (typeof val === 'object') ? JSON.stringify(val) : val; }
      }
      break;
  }
  event[enrichPrefix + 'lookup_status'] = 'success';
  event[enrichPrefix + 'lookup_ts'] = new Date().toISOString();
}

// -------------------------------------------------------
// BATCH: fire the pending batch — called when batch is full or timer expires
// -------------------------------------------------------
async function fireBatch() {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  if (pendingBatch.length === 0) return;

  const currentBatch = [...pendingBatch];
  pendingBatch = [];

  // Separate cached vs uncached
  const toFetch = [];
  for (const entry of currentBatch) {
    const cached = getCached(entry.lookupStr);
    if (cached) {
      enrichEvent(entry.event, cached);
      entry.event[enrichPrefix + 'cache_hit'] = true;
    } else if (entry.lookupStr) {
      toFetch.push(entry);
    } else {
      entry.event[enrichPrefix + 'lookup_status'] = 'skipped';
    }
  }

  if (toFetch.length > 0) {
    try {
      await rateLimit();
      const batchBody = toFetch.map(e => {
        const item = { query: e.lookupStr };
        const fieldsMatch = (extraQueryParams || '').match(/fields=([^&]+)/);
        if (fieldsMatch) item.fields = fieldsMatch[1];
        return item;
      });
      const headers = buildHeaders();
      const data = await makeRequest(batchUrl, 'POST', headers, JSON.stringify(batchBody));
      const results = Array.isArray(data) ? data : [];
      for (let i = 0; i < toFetch.length; i++) {
        const entry = toFetch[i];
        const result = results[i];
        if (result && result.status !== 'fail') {
          setCache(entry.lookupStr, result);
          enrichEvent(entry.event, result);
        } else {
          entry.event[enrichPrefix + 'lookup_status'] = result ? 'api_error' : 'no_result';
          if (result && result.message) entry.event[enrichPrefix + 'lookup_error'] = result.message;
        }
      }
    } catch (err) {
      cLogger.error(`Batch lookup failed: ${err.message}`);
      for (const entry of toFetch) {
        entry.event[enrichPrefix + 'lookup_status'] = 'error';
        entry.event[enrichPrefix + 'lookup_error'] = err.message;
      }
    }
  }

  // Resolve ALL promises — each event proceeds downstream
  for (const entry of currentBatch) {
    entry.resolve(entry.event);
  }
}

// -------------------------------------------------------
// SINGLE MODE: one API call per event
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
  if (cached) { enrichEvent(event, cached); event[enrichPrefix + 'cache_hit'] = true; return event; }

  const url = buildUrl(lookupStr);
  const headers = buildHeaders();
  const body = (requestMethod === 'POST' || requestMethod === 'PUT') ? buildBody(lookupStr) : null;
  return rateLimit()
    .then(() => makeRequest(url, requestMethod, headers, body))
    .then((apiData) => {
      if (apiData.status === 'fail') { event[enrichPrefix + 'lookup_status'] = 'api_error'; event[enrichPrefix + 'lookup_error'] = apiData.message || 'unknown'; return event; }
      setCache(lookupStr, apiData); enrichEvent(event, apiData); return event;
    })
    .catch((err) => { cLogger.error(`Lookup failed for ${lookupStr}: ${err.message}`); event[enrichPrefix + 'lookup_status'] = 'error'; event[enrichPrefix + 'lookup_error'] = err.message; return event; });
}

// -------------------------------------------------------
// exports.process — called once per event
// In batch mode: each event gets its own Promise that resolves when the batch fires
// This way Cribl holds each event (waiting on its Promise) instead of dropping it
// -------------------------------------------------------
exports.process = (event) => {
  if (!batchEnabled) return processSingle(event);

  const lookupValue = event[lookupField];
  if (!lookupValue) {
    event[enrichPrefix + 'lookup_status'] = 'skipped';
    event[enrichPrefix + 'lookup_reason'] = `Field '${lookupField}' is empty`;
    return event;
  }

  const lookupStr = String(lookupValue);

  // Each event gets its own Promise — Cribl waits for it
  return new Promise((resolve) => {
    pendingBatch.push({ event, lookupStr, resolve });

    // If batch is full, fire immediately
    if (pendingBatch.length >= batchSize) {
      fireBatch();
      return;
    }

    // Otherwise start/reset the timer for partial batches
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => { fireBatch(); }, batchTimeoutMs);
  });
};

// -------------------------------------------------------
// exports.flush — safety net for end-of-stream
// -------------------------------------------------------
exports.flush = () => {
  if (!batchEnabled || pendingBatch.length === 0) return null;
  cLogger.info(`Flushing final batch of ${pendingBatch.length} events`);
  fireBatch();
  return null; // events were already resolved via their Promises
};
