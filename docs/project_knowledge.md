# Custom API Enrichment for Cribl Stream — Project Knowledge

## How This File Works
This is the single source of truth for the Custom API Enrichment pack project. It lives in the Git repo at:
`C:\Users\James Pederson\Desktop\git\Remote\custom-api-enrichment\docs\project_knowledge.md`

The Claude project knowledge document is a **pointer file** (`claude_project_pointer.md`) that instructs Claude to read this file from the Filesystem MCP at the start of each conversation.

---

## Startup Sequence

Perform these steps in order at the start of every conversation. Do not prompt the user — run them automatically.

1. **Read this file** — via Filesystem MCP from the path above.
2. **Check Git status** — `cd "C:\Users\James Pederson\Desktop\git\Remote\custom-api-enrichment" && git log --oneline -5`
3. **Verify Cribl on-prem connectivity** — Test port 9000 on `10.198.32.60`
4. **Authenticate to Cribl** — POST to `http://10.198.32.60:9000/api/v1/auth/login` with credentials from the Credentials section.
5. **Verify pack is installed** — GET `http://10.198.32.60:9000/api/v1/m/default/packs/custom-api-enrichment`
6. **Report Status** — Print pass/fail summary, then confirm ready.

---

## Credentials

### Cribl On-Prem Leader
- **URL:** `http://10.198.32.60:9000`
- **Username:** `admin`
- **Password:** `QQV9vxaBWWpGFYD`
- **Worker Group:** `default`
- **UI Path:** `http://10.198.32.60:9000/stream/m/default/p/custom-api-enrichment`

### Cribl Cloud (NOT used for this pack — custom functions blocked on Cloud)
- **Org:** `busy-yonath-kz1bxn7`
- **URL:** `https://main-busy-yonath-kz1bxn7.cribl.cloud`
- **Auth endpoint:** `https://login.cribl.cloud/oauth/token`
- **Client ID:** `9cTJHeISnsmn504yw9KHJyWdvVHEVKcM`
- **Client Secret:** `5B5If27a4sgX8wUEhw6m4e3PFyaolRsEWidcOyDv2Q8nGGubFkGm1GL-wFVldFGN`
- **Note:** Pack was uploaded here but custom functions are blocked on managed Cloud workers. Use on-prem instead.

### GitHub
- **Account:** `jamespederson1`
- **Repo:** `https://github.com/jamespederson1/custom-api-enrichment`
- **CLI:** `gh` authenticated via keyring

---

## Project Overview

This project builds a **Cribl Stream Pack** that enriches events inline as they traverse pipelines by calling external REST API endpoints. The pack uses a **custom function** (the Nightfall DLP pack pattern — `exports.init`/`exports.process` with async Promises) to make outbound HTTP calls and merge API response data back into each event.

### Key Architecture Decision: Custom Function, Not Code Function
- **Code functions** (`id: code`) in Cribl **ban Promises** — they cannot make async HTTP calls.
- **Custom functions** (`functions/` directory with `index.js`) support Promises and `require()` — required for outbound API enrichment.
- Custom functions are **blocked on Cribl Cloud managed workers** but work on **on-prem and hybrid workers**.
- This is why the pack deploys to the on-prem leader at `10.198.32.60`, not Cribl Cloud.

### Default API: ip-api.com
The pack ships configured with **ip-api.com** (free, no auth) for IP geolocation enrichment as a ready-to-test demo. It's designed as a template customers can reconfigure for any REST API.

---

## Git Repository

**Local path:** `C:\Users\James Pederson\Desktop\git\Remote\custom-api-enrichment`
**GitHub remote:** `https://github.com/jamespederson1/custom-api-enrichment`
**Current version:** 0.9.0

---

## Pack Structure

```
custom-api-enrichment/
├── package.json                          # Pack metadata — version shown in Cribl UI
├── README.md
├── docs/
│   ├── project_knowledge.md              # This file
│   └── claude_project_pointer.md         # Pointer for Claude Desktop project
├── default/
│   ├── pack.yml                          # allowGlobalAccess: true
│   ├── samples.yml                       # Sample file registry (Nightfall pattern)
│   ├── functions/
│   │   └── custom_api_lookup/
│   │       ├── index.js                  # Core function (v0.5, single + batch modes)
│   │       ├── package.json              # No npm dependencies
│   │       ├── conf.schema.json          # UI form schema (all config fields)
│   │       └── config.ui-schema.json     # UI widget overrides (password, textarea)
│   └── pipelines/
│       ├── route.yml                     # 3 routes: single demo, batch demo, generic template
│       ├── custom_api_enrichment/
│       │   └── conf.yml                  # Single mode — ip-api.com (enabled)
│       ├── batch_api_enrichment/
│       │   └── conf.yml                  # Batch mode — ip-api.com /batch (disabled)
│       └── generic_api_enrichment/
│           └── conf.yml                  # Generic API template (disabled)
├── data/
│   └── samples/
│       ├── singleM1.json                 # 3 events for single mode testing
│       └── batchM1.json                  # 12 events for batch mode testing
└── dist/                                 # Built .crbl files (gitignored)
```

---

## Custom Function: `custom_api_lookup`

### How It Works
1. `exports.init(opts)` — reads config from pipeline's `conf` block, initializes cache, sets up auth
2. `exports.process(event)` — called once per event:
   - **Single mode:** Makes one HTTP request per event, returns a Promise that resolves to the enriched event
   - **Batch mode:** Returns a Promise per event; events accumulate in `pendingBatch`. When `batchSize` is reached (or `batchTimeoutMs` expires), one batch POST is made and all pending Promises resolve together.
3. `exports.flush()` — fires any remaining partial batch at end-of-stream

### URL Construction
No `{{value}}` template variables. The URL is built from separate config fields:
- **API Base URL** — e.g., `http://ip-api.com/json`
- **Value Position** — `path` (appends `/8.8.8.8`), `query` (adds `?q=8.8.8.8`), or `body` (POST only)
- **Extra Query Params** — e.g., `fields=status,country,city,isp`

Example for ip-api.com: `http://ip-api.com/json` + path + `8.8.8.8` + `?fields=...` → `http://ip-api.com/json/8.8.8.8?fields=...`

### Authentication Types
| Type | Behavior |
|------|----------|
| `none` | No auth header (ip-api.com free tier) |
| `bearer` | `Authorization: Bearer <key>` |
| `header` | Custom header: `<authHeaderName>: <key>` |
| `basic` | `Authorization: Basic <base64(key)>` |
| `query` | Appends `?api_key=<key>` to URL |

### Response Handling Modes
| Mode | Behavior |
|------|----------|
| `merge_fields` | Flatten all top-level response keys with prefix (default) |
| `store_raw` | Store entire JSON response as single field |
| `selective` | Pick specific dot-notation paths with optional rename mappings |

### Caching
- In-memory `Map` with configurable TTL (default 300s)
- Max 10,000 entries with LRU eviction
- Cache is per-worker-process (not shared across workers)
- Cache hit adds `<prefix>cache_hit: true` to event

### No npm Dependencies
Uses Node.js built-in `http`, `https`, and `url` modules only. No `node_modules` directory needed. Unlike the Nightfall pack which bundles `axios`/`nightfall-js` (~508KB), this pack has zero external dependencies.

---

## Pipelines

### 1. Single Mode — ip-api.com (enabled by default)
- Pipeline: `custom_api_enrichment`
- Sample: `singleM1.json` (3 events: 8.8.8.8, 1.1.1.1, 208.67.222.222)
- Each event makes its own GET to `http://ip-api.com/json/<ip>?fields=...`
- Events enriched with: `geo_country`, `geo_city`, `geo_isp`, `geo_org`, `geo_lat`, `geo_lon`, `geo_timezone`, etc.
- **This is the demo pipeline** — shows clear 1:1 input→enriched output

### 2. Batch Mode — ip-api.com (disabled)
- Pipeline: `batch_api_enrichment`
- Sample: `batchM1.json` (12 events, various public DNS/CDN IPs)
- `batchEnabled: true`, `batchSize: 6`, `batchUrl: http://ip-api.com/batch`
- Each event returns a Promise; batch fires when 6 accumulate or 2s timeout

#### IMPORTANT: Data Preview vs Live Traffic
**In Data Preview**, Cribl processes events **sequentially** — it waits for each event's Promise to resolve before sending the next. The batch never fills; each event fires individually (like single mode but hitting the `/batch` endpoint with 1 IP).

**In live traffic** with concurrent worker threads, multiple events arrive simultaneously and the batch accumulates properly, making one API call for N events. This is where batch mode shows its real value.

This is a fundamental Cribl architecture constraint, not a bug.

### 3. Generic API Template (disabled)
- Pipeline: `generic_api_enrichment`
- Placeholder URL: `https://your-api.example.com/v1/lookup`
- Bearer auth, `enrich_` prefix, 100ms rate limiting
- Comment block lists common patterns for GreyNoise, AbuseIPDB, VirusTotal, CMDB, etc.

---

## Sample Files

| File | ID in samples.yml | Events | Use With |
|------|-------------------|--------|----------|
| `data/samples/singleM1.json` | `singleM1` | 3 | Single mode pipeline |
| `data/samples/batchM1.json` | `batchM1` | 12 | Batch mode pipeline |

Sample format: JSON array (not NDJSON). Matches Nightfall pack pattern with `samples.yml` mapping IDs to filenames.

---

## Deployment Process

### Build .crbl
```powershell
cd "C:\Users\James Pederson\Desktop\git\Remote\custom-api-enrichment"
tar czf "$env:USERPROFILE\Downloads\custom_api_enrichment_<version>.crbl" --exclude='.git' --exclude='dist' --exclude='.gitignore' .
```

### Deploy to On-Prem (full cycle)
```powershell
# Authenticate
$auth = Invoke-RestMethod -Method POST -Uri 'http://10.198.32.60:9000/api/v1/auth/login' -ContentType 'application/json' -Body '{"username":"admin","password":"QQV9vxaBWWpGFYD"}'
$token = $auth.token

# Delete old pack
curl.exe -s -k -X DELETE "http://10.198.32.60:9000/api/v1/m/default/packs/custom-api-enrichment" -H "Authorization: Bearer $token"

# Upload new version (PUT with octet-stream, NOT multipart)
curl.exe -s -k -X PUT "http://10.198.32.60:9000/api/v1/m/default/packs?filename=<filename>.crbl" -H "Authorization: Bearer $token" -H "Content-Type: application/octet-stream" --data-binary "@<filepath>"

# Install (POST with source from upload response)
curl.exe -s -k -X POST "http://10.198.32.60:9000/api/v1/m/default/packs" -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d '{"source":"<source_from_upload>","id":"custom-api-enrichment"}'
```

### CRITICAL: version in Cribl UI comes from `package.json`, not commit messages or pack.yml

---

## Issues Encountered & Resolved

| Issue | Root Cause | Resolution |
|-------|-----------|------------|
| Custom functions blocked on Cribl Cloud | Cloud managed workers prohibit `functions/` directory in packs | Deploy to on-prem leader instead |
| Code function can't make HTTP calls | Promises, setTimeout, require() all banned in Code functions | Use custom function (Nightfall pattern) |
| `{{value}}` in URL confusing in UI | Looked like broken Cribl variable | Replaced with separate config fields: Base URL + Value Position + Extra Params |
| `samples.yml` caused "Cannot read properties of undefined" | Wrong YAML format | Used Nightfall pattern: ID-keyed entries with sampleName, created, size, numEvents |
| Sample files not visible in Cribl UI | Wrong file format (NDJSON instead of JSON array) | Switched to JSON arrays matching Nightfall's format |
| Pack version stuck at 0.4.0 in UI | `package.json` version wasn't updated | Version in UI comes from root `package.json`, not pack.yml or commits |
| Pack upload via POST/multipart failed | Cribl API requires PUT with `application/octet-stream` + `--data-binary` | Followed Cribl docs: two-step PUT upload + POST install |
| Batch mode dropped events (return null) | `return null` drops events instead of holding them | Switched to shared-Promise pattern: each event gets own Promise |
| Batch events passed through unenriched | Events 1-5 leaked without enrichment | Shared-Promise: Cribl waits on each Promise, no leaking |
| Batch mode acts like single mode in Preview | Cribl Preview processes events sequentially, waits per Promise | Architectural constraint; batch only works in live concurrent traffic |
| Orphan `batch_api_lookup` function directory | Created during iteration, not used | Deleted; batch pipeline uses `custom_api_lookup` with `batchEnabled: true` |
| `login.cribl.cloud` auth for Cloud | Different OAuth endpoint than on-prem | Cloud: POST to `https://login.cribl.cloud/oauth/token` with client_credentials grant |
| On-prem auth: username case-sensitive | Tried `Admin` (capital A) | Correct username is `admin` (lowercase) |

---

## Cribl API Quick Reference (On-Prem)

| Action | Method | Endpoint |
|--------|--------|----------|
| Authenticate | POST | `/api/v1/auth/login` |
| List packs | GET | `/api/v1/m/default/packs` |
| Get pack | GET | `/api/v1/m/default/packs/custom-api-enrichment` |
| Upload pack | PUT | `/api/v1/m/default/packs?filename=<name>.crbl` |
| Install pack | POST | `/api/v1/m/default/packs` (body: `{"source":"<upload_source>","id":"<pack_id>"}`) |
| Delete pack | DELETE | `/api/v1/m/default/packs/custom-api-enrichment` |

**Auth:** `Authorization: Bearer <token>` from login response.
**Upload:** Content-Type `application/octet-stream` with `--data-binary`.
**PowerShell tip:** PowerShell mangles inline JSON; write JSON to a temp file and use `-d @filepath`.

---

## Adapting for a Customer's API

To point the pack at a different API, edit the `custom_api_lookup` function settings in the pipeline:

1. **API Base URL** — Change to the customer's endpoint (e.g., `https://api.threatintel.com/v1/ip`)
2. **Value Position** — `path` for `/api/<value>`, `query` for `?param=<value>`, `body` for POST
3. **Auth Type** — Set to `bearer`, `header`, `basic`, or `query` and provide the API key
4. **Lookup Field** — Change if the IP isn't in `src_ip` (e.g., `ip`, `hostname`, `file_hash`)
5. **Enrichment Prefix** — Change from `geo_` to match the API's domain (e.g., `threat_`, `cmdb_`)
6. **Response Mode** — `merge_fields` for flat responses, `selective` for nested JSON with dot-notation

### Common Customer API Patterns

| API | Base URL | Position | Auth | Prefix |
|-----|----------|----------|------|--------|
| GreyNoise | `https://api.greynoise.io/v3/ip` | path | header (`key`) | `gn_` |
| AbuseIPDB | `https://api.abuseipdb.com/api/v2/check` | query (`ipAddress`) | header (`Key`) | `abuse_` |
| VirusTotal | `https://www.virustotal.com/api/v3/ip_addresses` | path | header (`x-apikey`) | `vt_` |
| Shodan | `https://api.shodan.io/shodan/host` | path | query (`key`) | `shodan_` |
| Internal CMDB | `https://cmdb.corp.com/api/asset` | query (`ip`) | bearer | `cmdb_` |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-03-23 | Initial custom function pack with `{{value}}` URL template |
| 0.2.0 | 2026-03-23 | Attempted Code function rewrite for Cloud (failed — Promises banned) |
| 0.3.0 | 2026-03-23 | Restored custom function for on-prem, configured ip-api.com |
| 0.4.0 | 2026-03-23 | Added generic API pipeline template |
| 0.5.0 | 2026-03-23 | Replaced `{{value}}` with proper config fields (Base URL + Value Position) |
| 0.6.0 | 2026-03-23 | Added `exports.flush()`, batch mode with buffer pattern |
| 0.7.0 | 2026-03-23 | Added sample files, dedicated single/batch pipelines |
| 0.8.0 | 2026-03-24 | Fixed sample format (JSON arrays, samples.yml with IDs) |
| 0.9.0 | 2026-03-24 | Fixed batch mode: shared-Promise pattern instead of return null |
| 0.9.2 | 2026-03-24 | Documented batch Preview vs live traffic behavior, added batchTimeoutMs |
