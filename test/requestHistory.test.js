// Hourly Request History: every request line counts once in its hour, whenever it is read.
// Regression for 2026-10-01: the logs service restarted at 00:06:58, 14 fallbacks followed at
// 00:07, and the 00:00 hour on the chart never showed them. Run: node test/requestHistory.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogService } = require('../logService');
const { recordRequestHistory, pruneRequestHistory } = require('../utils/metricsCalculators');
const { getStartOfHour } = require('../utils/timeUtils');

const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
const H = getStartOfHour(realNow()) - 3 * HOUR; // an hour safely in the past, as "00:00"
const at = (min, sec = 0) => H + min * 60 * 1000 + sec * 1000;
const line = (epoch, origin, status) => `v2|t|${epoch}|${origin}|203.0.113.7|eth_call|{}|1|${status}\n`;
const err = (code, message) => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: 1 });

(async () => {
  // ---- counting rules (unchanged from before)
  const h = new Map();
  recordRequestHistory(h, { epoch: String(at(1)), status: 'success' }, 'pool');
  recordRequestHistory(h, { epoch: String(at(2)), status: err(3, 'execution reverted') }, 'pool'); // caller's: not counted
  recordRequestHistory(h, { epoch: String(at(3)), status: err(-69005, 'Node timed out') }, 'pool');
  recordRequestHistory(h, { epoch: String(at(4)), status: err(-70000, 'Internal Proxy service error') }, 'fallback');
  recordRequestHistory(h, { epoch: String(at(5)), status: 'success', requester: 'buidlguidl-client' }, 'cache'); // not counted
  recordRequestHistory(h, { epoch: String(at(6)), status: 'success', requester: 'https://app.example' }, 'cache');
  recordRequestHistory(h, { epoch: 'garbage', status: 'success' }, 'pool'); // unreadable epoch: ignored
  assert.deepStrictEqual(h.get(H), { hourMs: H, nCacheRequestsSuccess: 1, nCacheRequestsError: 0, nCacheRequestsWarning: 0,
    nPoolRequestsSuccess: 1, nPoolRequestsError: 0, nPoolRequestsWarning: 1,
    nFallbackRequestsSuccess: 0, nFallbackRequestsError: 1, nFallbackRequestsWarning: 0 });
  for (let i = 1; i <= 5; i++) recordRequestHistory(h, { epoch: String(H - i * HOUR), status: 'success' }, 'pool');
  pruneRequestHistory(h, 3);
  assert.deepStrictEqual([...h.keys()].sort(), [H - 2 * HOUR, H - HOUR, H], 'newest 3 hours kept');

  // ---- the 2026-10-01 sequence, through the service
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqhistory-'));
  const write = (name, text) => fs.appendFileSync(path.join(dir, name), text);
  for (const f of ['poolRequests.log', 'cacheRequests.log', 'fallbackRequests.log', 'poolNodes.log', 'poolCompareResults.log']) write(f, '');
  write('poolRequests.log', line(at(0, 30), 'https://app.example', 'success').repeat(3));
  write('poolRequests.log', line(at(59, 50), 'https://app.example', 'success')); // hour before the restart's hour
  fs.writeFileSync(path.join(dir, 'poolRequests.log'),
    line(H - HOUR + 1000, 'https://app.example', 'success') + fs.readFileSync(path.join(dir, 'poolRequests.log'), 'utf8'));
  write('cacheRequests.log', line(at(1), 'https://app.example', 'success') + line(at(2), 'buidlguidl-client', 'success'));

  const log = console.log; console.log = () => {};
  let now = at(6, 58); Date.now = () => now; // the logs service restarts 6:58 into the hour
  const service = createLogService(dir);
  await service.initialize();
  const history = () => JSON.parse(service.respond('/dashboard').body).requestHistory;
  const hourH = () => history().find((x) => x.hourMs === H);
  assert.strictEqual(hourH(), undefined, 'the hour in progress is not on the chart yet');
  assert.deepStrictEqual(history().map((x) => [x.hourMs, x.nPoolRequestsSuccess]), [[H - HOUR, 1]], 'completed hours are');

  // 14 fallbacks and more pool traffic after the restart, still in the same hour
  for (let i = 0; i < 14; i++) write('fallbackRequests.log', line(at(7, i), 'https://app.example', 'success'));
  write('poolRequests.log', line(at(7, 20), 'https://app.example', 'success'));
  now = at(7, 30); await service.tick();
  assert.strictEqual(hourH(), undefined);

  // the hour ends: the chart gets the whole hour, fallbacks included
  write('poolRequests.log', line(at(60, 1), 'https://app.example', 'success')); // first line of the next hour
  now = at(60, 5); await service.tick();
  assert.deepStrictEqual(
    [hourH().nPoolRequestsSuccess, hourH().nCacheRequestsSuccess, hourH().nFallbackRequestsSuccess], [5, 1, 14],
    'every line of the hour, read before or after the restart (pool: 3 at 0:30, 1 at 59:50, 1 at 7:20)');

  // counted once: more ticks, an hour later still the same
  now = at(60, 15); await service.tick();
  now = at(125); await service.tick();
  assert.strictEqual(hourH().nFallbackRequestsSuccess, 14);
  assert.strictEqual(history().find((x) => x.hourMs === H + HOUR).nPoolRequestsSuccess, 1);

  // a fresh restart rebuilds the same hour from the files
  const again = createLogService(dir);
  await again.initialize();
  const rebuilt = JSON.parse(again.respond('/dashboard').body).requestHistory.find((x) => x.hourMs === H);
  assert.deepStrictEqual(rebuilt, hourH());

  Date.now = realNow; console.log = log;
  fs.rmSync(dir, { recursive: true });
  console.log('requestHistory: all passed');
})().catch((e) => { Date.now = realNow; console.error(e); process.exit(1); });
