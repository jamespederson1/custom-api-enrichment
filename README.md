# Custom API Enrichment Pack for Cribl

## Overview

This Cribl Stream pack enriches pipeline events by calling a custom REST API endpoint during processing. It uses the same **custom function** approach as the Nightfall DLP pack — a Node.js function with `exports.init` / `exports.process` that makes async HTTP requests and merges the response data back into each event.

## How It Works

1. For each event flowing through the pipeline, the function extracts a configurable **lookup field** (e.g., `ip`, `src_ip`, `hostname`, `hash`)
2. It calls your custom API endpoint with that value (via GET or POST)
3. The API response is parsed and merged back into the event as enrichment fields
4. The enriched event continues down the pipeline to its destination

## Features

- **Multiple Auth Types**: Bearer token, custom header (like GreyNoise `key` header), query parameter, Basic auth, or no auth
- **GET and POST**: GET with URL placeholder or query params; POST with configurable JSON body template
- **Response Handling Modes**:
  - `merge_fields` — flatten all top-level response keys with a prefix (e.g., `enrichment_score`, `enrichment_country`)
  - `store_raw` — store the entire JSON response as a single field
  - `selective` — pick specific response fields by dot-notation path with optional renaming
- **In-Memory Cache**: Configurable TTL to avoid duplicate lookups for the same value
- **Rate Limiting**: Configurable minimum interval between API requests
- **Custom Headers**: Add any additional HTTP headers your API requires
- **Error Handling**: Failed lookups add `enrichment_status: error` and `enrichment_error` fields without dropping the event

## Configuration

### Required Settings

| Setting | Description | Example |
|---------|-------------|---------|
| **API Endpoint URL** | Full URL with `{{value}}` placeholder | `https://api.example.com/lookup/{{value}}` |
| **Lookup Field** | Event field to send to the API | `ip`, `src_ip`, `hostname` |

### Authentication

| Auth Type | How the API Key is Sent |
|-----------|------------------------|
| Bearer Token | `Authorization: Bearer <key>` |
| Custom Header | `<HeaderName>: <key>` (e.g., `key: <api_key>` for GreyNoise) |
| Query Parameter | `?api_key=<key>` appended to URL |
| Basic Auth | `Authorization: Basic <base64(key)>` |
| None | No authentication header |

### Example Configurations

#### GreyNoise IP Context
```
API URL:        https://api.greynoise.io/v3/ip/{{value}}
Auth Type:      Custom Header
Header Name:    key
Lookup Field:   src_ip
Prefix:         gn_
Response Mode:  selective
Selected Fields: classification, tags, metadata.organization, metadata.asn
```

#### AbuseIPDB Check
```
API URL:        https://api.abuseipdb.com/api/v2/check?ipAddress={{value}}
Auth Type:      Custom Header
Header Name:    Key
Lookup Field:   ip
Prefix:         abuse_
Response Mode:  merge_fields
```

#### VirusTotal IP Lookup
```
API URL:        https://www.virustotal.com/api/v3/ip_addresses/{{value}}
Auth Type:      Custom Header
Header Name:    x-apikey
Lookup Field:   src_ip
Prefix:         vt_
Response Mode:  selective
Selected Fields: data.attributes.reputation, data.attributes.country
```

#### Custom Internal API (POST)
```
API URL:        https://internal-api.corp.com/enrich
Method:         POST
Body Template:  {"indicator": "{{value}}", "type": "ip", "context": "siem"}
Auth Type:      Bearer Token
Lookup Field:   ip
Prefix:         corp_
Response Mode:  merge_fields
```

## Architecture

This pack follows the same pattern as the **Nightfall DLP for Cribl** pack:

```
default/
├── pack.yml                            # Pack manifest
├── samples.yml                         # Sample data config
├── functions/
│   └── custom_api_lookup/
│       ├── index.js                    # Core function (init + process)
│       ├── package.json                # Node.js package manifest
│       ├── conf.schema.json            # UI configuration schema
│       └── config.ui-schema.json       # UI widget overrides
├── pipelines/
│   ├── route.yml                       # Pack routing
│   └── custom_api_enrichment/
│       └── conf.yml                    # Pipeline with the custom function
data/
└── samples/
    └── sample_events.json              # Test events
dist/                                   # Built .crbl pack files
```

### Key Design Decisions

- **No npm dependencies**: Uses Node.js built-in `http`/`https` modules (unlike Nightfall which bundles `axios`/`nightfall-js`). This means no `node_modules` directory — the pack is lightweight and doesn't require `npm install`.
- **Async promise pattern**: Returns a Promise from `exports.process` just like Nightfall, which Cribl handles natively for async functions.
- **Pipeline `asyncFuncTimeout`**: Set to 10000ms (10s) to allow for slower API responses. Adjust if your API is faster or slower.

## Installation

1. Import this pack into your Cribl Stream instance
2. Configure the function settings (API URL, auth, lookup field)
3. Attach the pipeline to your desired route
4. Test with sample data before enabling on production traffic

## Performance Considerations

- **Enable caching** (default 300s TTL) to reduce API calls for repeated values
- **Use rate limiting** if your API has request quotas
- **Set `asyncFuncTimeout`** in the pipeline appropriately for your API's response time
- For high-volume pipelines, consider using the function's filter to only enrich specific events (e.g., `classification == 'malicious'`)
