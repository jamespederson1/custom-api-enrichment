const http = require('http');
const https = require('https');
const { URL } = require('url');

const cLogger = C.util.getLogger('func:batch_api_lookup');

exports.name = 'Batch API Lookup';
exports.version = '0.1';
exports.group = 'Standard';

// --- Configuration state ---
let apiBaseUrl = '';
let apiKey = '';
let authType = 'none';
let authHeaderName = 'Authorization';
let lookupField = 'src_ip';
let enrichPrefix = 'enrich_';
let requestTimeout = 10000;
let bodyTemplate = '';
let responseMatchField = '';
let staticHeaders = {};
let cacheTTL = 300;
let cache = new Map();
let cacheTimestamps = new Map();

exports.init = (opts) => {
  const conf = opts.conf || {};

  apiBaseUrl = (conf.apiBaseUrl || '').replace(/\/+$/, '');
  apiKey = conf.apiKey || '';
  authType = conf.authType || 'none';
  authHeaderName = conf.authHeaderName || 'Authorization';
  lookupField = conf.lookupField || 'src_ip';
  enrichPrefix = conf.enrichPrefix || 'enrich_';
  requestTimeout = parseInt(conf.requestTimeout, 10) || 10000;
  bodyTemplate = conf.bodyTemplate || '';
  responseMatchField = conf.responseMatchField || '';
  staticHeaders = {};
  if (conf.staticHeaders && Array.isArray(conf.staticHeaders)) {
    for (const h of conf.staticHeaders) {
      if (h.name && h.value) staticHeaders[h.name] = h.value;
    }
  }
  cacheTTL = parseInt(conf.cacheTTL, 10) || 300;
  cache = new Map();
  cacheTimestamps = new Map();

  // Allow self-signed certs for internal APIs
  if (conf.allowSelfSigned) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  cLogger.info(`Batch API Lookup initialized: base=${apiBaseUrl}, field=${lookupField}, auth=${authType}`);
};

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

// --- Header builder ---
function buildHeaders() {
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'CriblStream/1.0', ...staticHeaders };
  switch (authType) {
    case 'bearer': headers['Authorization'] = `Bearer ${apiKey}`; break;
    case 'header': headers[authHeaderName] = apiKey; break;
    case 'basic': headers['Authorization'] = `Basic ${Buffer.from(apiKey).toString('base64')}`; break;
    case 'none': default: break;
  }
  return headers;
}

// --- Build batch request body ---
// Takes an array of lookup values and builds the POST body
// Default format: { "ips": ["8.8.8.8", "1.1.1.1", ...] }
// Custom format: use bodyTemplate with {lookup_values} placeholder for JSON array
function buildBatchBody(lookupValues) {
  if (bodyTemplate) {
    return bodyTemplate.replace(/\{lookup_values\}/g, JSON.stringify(lookupValues));
  }
  return JSON.stringify({ ips: lookupValues });
}

// --- HTTP request returning a Promise ---
function makeRequest(url, headers, body) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
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
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${requestTimeout}ms`)); });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------
// BATCH ENRICHMENT PATTERN
// ---------------------------------------------------------------
// This function expects to receive events that have been PRE-AGGREGATED
// by Cribl's built-in Aggregation function upstream in the pipeline.
//
// The Aggregation function collects individual events into one event
// where the lookup field contains an ARRAY of values:
//   list(src_ip).as(src_ip_batch)
//   list(_raw).as(_raw_batch)
//
// This function then:
//   1. Reads the array of lookup values from the aggregated event
//   2. Deduplicates and checks cache
//   3. Makes ONE batch API call with all unique values
//   4. Maps results back into the aggregated arrays
//   5. Returns the event (still aggregated)
//
// AFTER this function, use Cribl's built-in Unroll function to
// split the arrays back into individual enriched events.
// ---------------------------------------------------------------

exports.process = (event) => {
  // The aggregation function creates array fields
  // e.g., list(src_ip).as(src_ip_batch) -> event.src_ip_batch = ["8.8.8.8", "1.1.1.1", ...]
  // e.g., list(_raw).as(_raw_batch)     -> event._raw_batch = ["{...}", "{...}", ...]
  const batchFieldName = lookupField + '_batch';
  const lookupValues = event[batchFieldName];

  if (!lookupValues || !Array.isArray(lookupValues) || lookupValues.length === 0) {
    // Not an aggregated event — might be a single event, try the direct field
    const singleValue = event[lookupField];
    if (!singleValue) {
      event[enrichPrefix + 'status'] = 'skipped';
      event[enrichPrefix + 'reason'] = `No batch field '${batchFieldName}' or direct field '${lookupField}' found`;
      return event;
    }
    // Wrap single value to process as batch of 1
    event[batchFieldName] = [singleValue];
  }

  const batchValues = event[batchFieldName];
  const batchSize = batchValues.length;

  // Deduplicate and check cache
  const uniqueValues = [...new Set(batchValues.map(String))];
  const cached = {};
  const toFetch = [];

  for (const val of uniqueValues) {
    const hit = getCached(val);
    if (hit) {
      cached[val] = hit;
    } else {
      toFetch.push(val);
    }
  }

  // If everything was cached, enrich immediately
  if (toFetch.length === 0) {
    applyEnrichment(event, batchValues, cached);
    event[enrichPrefix + 'cache_hit'] = true;
    event[enrichPrefix + 'batch_size'] = batchSize;
    return event;
  }

  // Build and execute batch API call
  const url = apiBaseUrl;
  const headers = buildHeaders();
  const body = buildBatchBody(toFetch);

  return makeRequest(url, headers, body)
    .then((apiData) => {
      // Parse the API response into a lookup map
      // The response should be either:
      //   1. An array matching the request order: [{...}, {...}, ...]
      //   2. An object keyed by lookup value: { "8.8.8.8": {...}, "1.1.1.1": {...} }
      //   3. An object with a results array: { results: [{ip: "8.8.8.8", ...}, ...] }
      const resultsMap = parseApiResponse(apiData, toFetch);

      // Cache the results
      for (const [key, val] of Object.entries(resultsMap)) {
        setCache(key, val);
      }

      // Merge cached + fresh results
      const allResults = { ...cached, ...resultsMap };
      applyEnrichment(event, batchValues, allResults);
      event[enrichPrefix + 'status'] = 'success';
      event[enrichPrefix + 'batch_size'] = batchSize;
      event[enrichPrefix + 'fetched'] = toFetch.length;
      event[enrichPrefix + 'cached'] = Object.keys(cached).length;
      return event;
    })
    .catch((err) => {
      cLogger.error(`Batch API lookup failed: ${err.message}`);
      // Still enrich with whatever was cached
      applyEnrichment(event, batchValues, cached);
      event[enrichPrefix + 'status'] = 'error';
      event[enrichPrefix + 'error'] = err.message;
      event[enrichPrefix + 'batch_size'] = batchSize;
      return event;
    });
};

// ---------------------------------------------------------------
// Parse API response into a map of { lookupValue: enrichmentData }
// Handles three common response formats:
//   1. Array indexed same as request
//   2. Object keyed by lookup value
//   3. Object with results array containing a match field
// ---------------------------------------------------------------
function parseApiResponse(apiData, requestedValues) {
  const resultsMap = {};

  if (Array.isArray(apiData)) {
    // Format 1: Array in same order as request
    apiData.forEach((result, i) => {
      if (i < requestedValues.length && result) {
        resultsMap[requestedValues[i]] = result;
      }
    });
  } else if (apiData && typeof apiData === 'object') {
    // Check for results array
    const resultsArray = apiData.results || apiData.data || apiData.items;

    if (Array.isArray(resultsArray)) {
      if (responseMatchField) {
        // Format 3: Match by field (e.g., result.ipAddress matches the lookup value)
        for (const result of resultsArray) {
          const matchVal = String(result[responseMatchField] || '');
          if (requestedValues.includes(matchVal)) {
            resultsMap[matchVal] = result;
          }
        }
      } else {
        // Assume same order as request
        resultsArray.forEach((result, i) => {
          if (i < requestedValues.length && result) {
            resultsMap[requestedValues[i]] = result;
          }
        });
      }
    } else {
      // Format 2: Object keyed by lookup value
      for (const val of requestedValues) {
        if (apiData[val]) {
          resultsMap[val] = apiData[val];
        }
      }
    }
  }

  return resultsMap;
}

// ---------------------------------------------------------------
// Apply enrichment data back into the aggregated event
// Creates parallel arrays for each enrichment field so they can
// be unrolled alongside the original data arrays.
//
// Example:
//   Input:  event.src_ip_batch = ["8.8.8.8", "1.1.1.1"]
//   Output: event.enrich_country = ["United States", "Australia"]
//           event.enrich_org     = ["Google LLC", "Cloudflare"]
//
// After Unroll, each individual event gets its matching enrichment.
// ---------------------------------------------------------------
function applyEnrichment(event, batchValues, resultsMap) {
  // Collect all unique enrichment field names across all results
  const allFields = new Set();
  for (const result of Object.values(resultsMap)) {
    if (result && typeof result === 'object') {
      for (const key of Object.keys(result)) {
        allFields.add(key);
      }
    }
  }

  // Create parallel arrays for each enrichment field
  for (const field of allFields) {
    const enrichArray = batchValues.map(val => {
      const result = resultsMap[String(val)];
      if (!result) return '';
      const v = result[field];
      if (v === null || v === undefined) return '';
      return (typeof v === 'object') ? JSON.stringify(v) : v;
    });
    event[enrichPrefix + field] = enrichArray;
  }
}
