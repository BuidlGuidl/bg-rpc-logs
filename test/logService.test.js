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

  console.log = log;
  fs.rmSync(dir, { recursive: true });
  console.log('logService: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
