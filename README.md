# bg-rpc-logs

In-memory log aggregator for the BuidlGuidl RPC stack. It tails the shared request logs written by the proxy and pool, keeps rolling metrics in memory, and serves them as JSON over HTTPS for the web dashboard.

This process does not receive RPC traffic. The proxy (`bg-rpc-proxy`) and pool (`bg-rpc-pool`) write pipe-delimited lines into `../shared/`. This service reads those files, and `bg-rpc-web-server` fetches the HTTP API to render dashboards, requestor tables, and log views.

## What it tracks

Incoming RPC work is split across three request logs:

| Log | Written by | Meaning |
| --- | --- | --- |
| `shared/fallbackRequests.log` | proxy | Requests that missed cache and the node pool and went to the fallback provider |
| `shared/cacheRequests.log` | proxy | Requests served from cache (including `buidlguidl-client`) |
| `shared/poolRequests.log` | proxy | Requests forwarded to the community node pool |

Two more files come from the pool itself:

| Log | Meaning |
| --- | --- |
| `shared/poolNodes.log` | Per-node method, duration, and status (including timeouts) |
| `shared/poolCompareResults.log` | Consensus checks across three nodes; only **mismatches** are kept |

Each request line is `timestamp|epoch|requester|method|params|elapsed|status`. Node lines add `nodeId` and `owner`.

## How it works

1. On startup, parse the tail of each log (last 40,000 request/node lines) using byte offsets so later ticks only read new data. Rotated or truncated files are re-read from the start.
2. Re-parse request, node, and compare logs every 10 seconds. Node timing histograms refresh every 10 minutes. Hourly request history and node timeout rates refresh when the clock rolls to a new hour.
3. Store parsed rows in Maps, then cache derived metrics:
   - Last-hour counts, errors, warnings, and median latency (cache vs pool vs fallback; client cache traffic is counted separately)
   - Duration percentiles (p1 / p25 / p50 / p75 / p99) by method, origin, and node
   - 30 days of hourly success / warning / error history
   - Per-requestor volume (all-time and last week)
   - Per-node timeout rate for the last day and last week
4. Errors whose JSON-RPC code is in `shared/ignoredErrorCodes.js` (bad user requests) are not treated as failures. Codes starting with `-69` count as warnings.

## HTTP API

HTTPS on port **3001**, using `shared/server.key` and `shared/server.cert`. All responses are JSON.

| Path | Payload |
| --- | --- |
| `/fallbackRequests`, `/cacheRequests`, `/poolRequests` | Recent request rows |
| `/poolNodes` | Recent per-node rows |
| `/poolCompareResults` | Consensus mismatches only |
| `/dashboard` | Aggregated dashboard metrics and hourly history |
| `/requestorTable` | Per-origin request counts |
| `/nodeTimeoutPercentLastWeek` | Timeout rate by node over 7 days |
| `/nodeTimeoutPercentLastDay` | Timeout rate by node over 24 hours |

Anything else returns `404`.

## Layout

```
logs.js                      HTTPS server, parse loop, in-memory maps
config.js                    Port, intervals, retention caps
utils/logParsers.js          Incremental file readers
utils/metricsCalculators.js  Dashboard, requestor, and timeout metrics
utils/dataTransformers.js    Map → JSON, node ID pretty-print
utils/fileUtils.js           Line counts and byte offsets
utils/mathUtils.js           Percentiles
utils/timeUtils.js           Hour buckets
```

## Run

```bash
npm install
npm start
```

On this host it runs as the PM2 process `logs`. It expects the shared log files and TLS certs to already exist next to this repo in `../shared/`.

## License

MIT. See [LICENSE](LICENSE).
