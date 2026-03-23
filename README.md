# Custom API Enrichment Pack for Cribl Stream

## Overview

This Cribl Stream pack enriches events **inline** as they traverse your pipelines — no batch collection needed. It calls a REST API for each event (or from cache) and merges the response data back into the event before it continues downstream.

The default configuration uses **ip-api.com** (free, no auth required) to add IP geolocation data (country, city, ISP, org, lat/lon, timezone) to every event with a `src_ip` field. It's designed as a template you can easily adapt to any REST API.

## Key Design: Code Function (Not Custom Function)

This pack uses Cribl's **built-in Code function** rather than a custom function (`functions/` directory). This is important because:

- **Works on Cribl Cloud managed workers** — custom functions are blocked on Cloud
- **No npm dependencies** — uses Node.js built-in `http`/`https` modules
- **No `node_modules` directory** — the pack stays tiny
- **Easy to edit** — all logic is visible in the pipeline's Code function in the Cribl UI

The tradeoff is that all configuration is done by editing constants at the top of the Code function rather than through a dedicated UI form. For a customer-facing pack, this is actually more transparent.

## How It Works

1. Event arrives in the pipeline with a `src_ip` field (configurable)
2. Code function checks the in-memory cache for a previous lookup of that IP
3. If not cached, makes an HTTP GET to `http://ip-api.com/json/<ip>`
4. Merges response fields into the event with a `geo_` prefix
5. Caches the result for 300 seconds (configurable)
6. Event continues downstream with enrichment fields attached

### Fields Added to Each Event

| Field | Example | Description |
|-------|---------|-------------|
| `geo_country` | United States | Country name |
| `geo_countryCode` | US | ISO country code |
| `geo_regionName` | California | State/region |
| `geo_city` | Mountain View | City |
| `geo_zip` | 94043 | Postal code |
| `geo_lat` | 37.4056 | Latitude |
| `geo_lon` | -122.0775 | Longitude |
| `geo_timezone` | America/Los_Angeles | Timezone |
| `geo_isp` | Google LLC | ISP name |
| `geo_org` | Google LLC | Organization |
| `geo_as` | AS15169 Google LLC | Autonomous system |
| `geo_status` | success | Lookup status |
| `geo_timestamp` | 2026-03-23T... | When the lookup occurred |

## Adapting for Your Own API

Edit the constants at the top of the Code function in the pipeline:

```javascript
const LOOKUP_FIELD = 'src_ip';           // Change to your event field
const ENRICH_PREFIX = 'threat_';         // Change the prefix
const API_URL_TEMPLATE = 'https://your-api.com/lookup/{{value}}';
const REQUEST_TIMEOUT = 5000;
const CACHE_TTL = 300;
```

For authenticated APIs, add headers in the `makeRequest` function:

```javascript
headers: {
  'Accept': 'application/json',
  'Authorization': 'Bearer YOUR_TOKEN',   // Bearer auth
  // 'X-API-Key': 'YOUR_KEY',             // Header auth
  // 'key': 'YOUR_KEY',                    // GreyNoise-style
}
```

For POST-based APIs, change the method and add a body in `makeRequest`.

## Architecture

```
default/
├── pack.yml                              # Pack manifest
├── samples.yml                           # Sample data config
└── pipelines/
    ├── route.yml                         # Pack routing
    └── custom_api_enrichment/
        └── conf.yml                      # Pipeline with Code function
data/
└── samples/
    └── sample_events.json                # Test events (8.8.8.8, 1.1.1.1, etc.)
package.json                              # Pack package metadata
```

## Installation

1. Import the `.crbl` file into your Cribl Stream instance (Packs > Add Pack > Import from File)
2. Attach the `custom_api_enrichment` pipeline to your desired route
3. Test with the included sample data (8.8.8.8, 1.1.1.1, 208.67.222.222)
4. Edit the Code function constants to point to your own API when ready

## Performance Notes

- **Caching** (default 300s) dramatically reduces API calls for repeated IPs
- **ip-api.com** allows 45 requests/minute on the free tier — enable caching
- **`asyncFuncTimeout`** is set to 10s in the pipeline — adjust for your API
- Use the pipeline filter to only enrich specific events if volume is high
