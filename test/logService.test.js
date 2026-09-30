// logService: responses are serialized once per data change; the dashboard is rebuilt only when a
// log changed or it is maxDashboardAgeMs old. Run: node test/logService.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogService } = require('../logService');
const { maxDashboardAgeMs } = require('../config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logservice-'));
const now = Date.now();
const req = (i) => `v2|2026-09-30 12:00:00|${now - 5000 + i}|https://app.example|203.0.113.7|eth_call|{"to":"0x1"},latest|${10 + i}|success\n`;
const node = (i) => `2026-09-30 12:00:00|${now - 5000 + i}|node-a|owner-a|eth_call|{"to":"0x1"},latest|${10 + i}|success\n`;
fs.writeFileSync(path.join(dir, 'poolRequests.log'), req(0) + req(1));
fs.writeFileSync(path.join(dir, 'cacheRequests.log'), req(2));
fs.writeFileSync(path.join(dir, 'fallbackRequests.log'), '');
fs.writeFileSync(path.join(dir, 'poolNodes.log'), node(0) + node(1));
fs.writeFileSync(path.join(dir, 'poolCompareResults.log'), '');

(async () => {
  const log = console.log; console.log = () => {};
  const service = createLogService(dir);
  await service.initialize();
  const { versions, responseCache } = service.state;

  // ---- every route answers; unknown ones 404
  for (const url of ['/fallbackRequests', '/cacheRequests', '/poolRequests', '/poolCompareResults', '/poolNodes',
    '/dashboard', '/requestorTable', '/nodeTimeoutPercentLastWeek', '/nodeTimeoutPercentLastDay']) {
    const { statusCode, body } = service.respond(url);
    assert.strictEqual(statusCode, 200, url);
    assert.ok(JSON.parse(body) !== undefined, url);
  }
  assert.strictEqual(service.respond('/nope').statusCode, 404);
  assert.strictEqual(JSON.parse(service.respond('/poolRequests').body).length, 2);
  assert.strictEqual(JSON.parse(service.respond('/nodeTimeoutPercentLastWeek').body)[0].nodeId, 'node-a');

  // ---- same data: the stored body is reused
  const first = responseCache.get('/poolRequests');
  service.respond('/poolRequests');
  assert.strictEqual(responseCache.get('/poolRequests'), first, 'not rebuilt');

  // ---- a tick with nothing new: dashboard not rebuilt, responses kept
  const dashboardVersion = versions.dashboard;
  await service.tick();
  assert.strictEqual(versions.dashboard, dashboardVersion);
  assert.strictEqual(responseCache.get('/poolRequests'), first);

  // ---- a new pool request: pool response dropped and rebuilt with it, others kept, dashboard rebuilt
  const nodesBody = responseCache.get('/poolNodes');
  fs.appendFileSync(path.join(dir, 'poolRequests.log'), req(3));
  await service.tick();
  assert.strictEqual(responseCache.has('/poolRequests'), false, 'stale body freed');
  assert.strictEqual(responseCache.get('/poolNodes'), nodesBody, 'unchanged data keeps its body');
  assert.strictEqual(versions.dashboard, dashboardVersion + 1);
  assert.strictEqual(JSON.parse(service.respond('/poolRequests').body).length, 3);
  assert.strictEqual(JSON.parse(service.respond('/dashboard').body).nPoolRequestsLastHour, 3);

  // ---- nothing new but the dashboard is maxDashboardAgeMs old: rebuilt (its last-hour counts move with time)
  const realNow = Date.now;
  Date.now = () => realNow() + maxDashboardAgeMs;
  await service.tick();
  Date.now = realNow;
  assert.strictEqual(versions.dashboard, dashboardVersion + 2);

  // ---- paged views (logs page): newest first, filtered, with each entry's error class
  const err = JSON.stringify({ jsonrpc: '2.0', error: { code: -70000, message: 'Internal Proxy service error' }, id: 1 });
  const rev = JSON.stringify({ jsonrpc: '2.0', error: { code: 3, message: 'execution reverted' }, id: 1 });
  fs.appendFileSync(path.join(dir, 'poolRequests.log'),
    `v2|2026-09-30 12:00:04|${now - 5000 + 4}|buidlguidl-client|-|eth_blockNumber||1|success\n` +
    `v2|2026-09-30 12:00:05|${now - 5000 + 5}|https://app.example|203.0.113.7|eth_call|{}|2|${err}\n` +
    `v2|2026-09-30 12:00:06|${now - 5000 + 6}|https://app.example|203.0.113.7|eth_call|{}|3|${rev}\n`);
  fs.appendFileSync(path.join(dir, 'poolNodes.log'), `2026-09-30 12:00:07|${now}|node-a|owner-a|eth_call|{}|5000|timeout_error\n`);
  const cmp = (i, match) => [`2026-09-30 12:00:0${i}`, now + i, match, 'node-b', 'owner-b', '[]', 'node-a', '"0x1"', 'node-b', '"0x2"', 'node-c', '"0x1"', 'eth_call', '{}'].join('|');
  fs.appendFileSync(path.join(dir, 'poolCompareResults.log'), [cmp(1, 'false'), cmp(2, 'true'), cmp(3, 'false')].join('\n') + '\n');
  await service.tick();
  const page = (url) => { const r = service.respond(url); assert.strictEqual(r.statusCode, 200, url); return JSON.parse(r.body); };

  let p = page('/poolRequests?page=1&limit=2&filter=all');
  assert.strictEqual(p.total, 6);
  assert.deepStrictEqual(p.entries.map((e) => e.elapsed), [3, 2], 'newest first');
  assert.deepStrictEqual(p.entries.map((e) => e.errorClass), ['caller', 'error']);
  assert.deepStrictEqual(page('/poolRequests?page=3&limit=2&filter=all').entries.map((e) => e.elapsed), [11, 10]);
  assert.deepStrictEqual(page('/poolRequests?page=4&limit=2&filter=all').entries, [], 'past the end: empty page, same total');
  assert.strictEqual(page('/poolRequests?page=1&filter=no-client').total, 5);
  assert.deepStrictEqual(page('/poolRequests?page=1&filter=error').entries.map((e) => e.elapsed), [2]);
  assert.strictEqual(page('/poolRequests?page=1&filter=success').total, 4, 'the reverted call is the caller\'s: neither success nor error');
  assert.strictEqual(page('/poolRequests?page=1').limit, 30, 'default limit');
  assert.deepStrictEqual(page('/poolNodes?page=1&filter=warning').entries.map((e) => [e.status, e.errorClass]), [['timeout_error', 'warning']]);
  assert.strictEqual(page('/poolNodes?page=1&filter=no-client').total, 3, 'node entries have no requester: all kept');
  p = page('/poolCompareResults?page=1&filter=all');
  assert.deepStrictEqual(p.entries.map((e) => e.lineIndex), [2, 0], 'only mismatches are kept, newest first');
  assert.strictEqual(p.entries[0].errorClass, undefined);
  assert.strictEqual(page('/poolCompareResults?page=1&filter=success').total, 0);
  assert.strictEqual(page('/poolCompareResults?page=1&filter=no-client').total, 2, 'any filter but all/success: mismatches');
  for (const bad of ['page=0', 'page=x', 'page=1&limit=0', 'page=1&limit=1001', 'page=1&filter=nope']) {
    assert.strictEqual(service.respond(`/poolRequests?${bad}`).statusCode, 400, bad);
  }
  assert.strictEqual(service.respond('/dashboard?page=1').statusCode, 200, 'page is ignored outside the tables');
  assert.ok(Array.isArray(JSON.parse(service.respond('/poolRequests').body)), 'without page: the whole table, as before');
  assert.strictEqual(JSON.parse(service.respond('/poolRequests').body)[0].errorClass, undefined);

  console.log = log;
  fs.rmSync(dir, { recursive: true });
  console.log('logService: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
