// Merged requests (bg-rpc-proxy request merging): mergedRequests.log read into a paged table whose
// entries take status, params and error class from their own cache line, with the logs page's
// filters and search. Run: node test/mergedRequests.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogService } = require('../logService');
const { parseMergedLogLine } = require('../utils/requestLogLine');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedlog-'));
const T = 1791493451000;
const reverted = '{"jsonrpc":"2.0","id":3,"error":{"code":3,"message":"execution reverted"}}';
// cache lines exactly as bg-rpc-proxy writes them for merged requests: elapsed = the wait
const cache = (epoch, origin, ip, method, params, wait, status) => `v2|2026-10-08 21:04:11|${epoch}|${origin}|${ip}|${method}|${params}|${wait}|${status}\n`;
const merged = (epoch, origin, ip, method, wait, leader, same) => `m1|2026-10-08 21:04:11|${epoch}|${origin}|${ip}|${method}|${wait}|${leader}|${same}\n`;
for (const f of ['poolRequests.log', 'fallbackRequests.log', 'poolNodes.log', 'poolCompareResults.log']) fs.writeFileSync(path.join(dir, f), '');

(async () => {
  const log = console.log; console.log = () => {};

  // ---- no mergedRequests.log yet (a proxy without merging): no error, empty table
  fs.writeFileSync(path.join(dir, 'cacheRequests.log'), '');
  const errors = []; const err = console.error; console.error = (...a) => errors.push(a.join(' '));
  const service = createLogService(dir);
  await service.initialize();
  assert.deepStrictEqual(JSON.parse(service.respond('/mergedRequests?page=1').body).entries, []);
  assert.deepStrictEqual(errors, [], 'a missing merged log is not an error');
  console.error = err;

  // ---- the file appears: three merged requests and their cache lines
  fs.writeFileSync(path.join(dir, 'cacheRequests.log'), [
    cache(T + 1, '', '203.0.113.7', 'eth_call', '{"to":"0xusdc","data":"0xaa"},0x18f0564', 40, 'success'),
    cache(T + 2, 'https://app.example', '198.51.100.9', 'eth_call', '{"to":"0xusdc","data":"0xbb"},0x18f0564', 31, reverted),
    cache(T + 3, 'buidlguidl-client', '192.0.2.1', 'eth_getBalance', '0xabc,0x18f0564', 12, 'success'),
    cache(T + 9, '', '203.0.113.7', 'eth_chainId', '', 0.05, 'success') // a real cache hit: no merged line
  ].join(''));
  fs.writeFileSync(path.join(dir, 'mergedRequests.log'), [
    merged(T + 1, '', '203.0.113.7', 'eth_call', 40, T - 10, 1),
    merged(T + 2, 'https://app.example', '198.51.100.9', 'eth_call', 31, T - 20, 0),
    merged(T + 3, 'buidlguidl-client', '192.0.2.1', 'eth_getBalance', 12, T - 5, 1),
    merged(T + 4, '', '203.0.113.8', 'eth_call', 7, T, 1), // its cache line isn't there
    'm1|broken|line\n'
  ].join(''));
  await service.tick();
  const page = (q) => JSON.parse(service.respond(`/mergedRequests?page=1&${q}`).body);

  let r = page('filter=all');
  assert.strictEqual(r.total, 4, 'four readable lines; the broken one skipped');
  assert.deepStrictEqual(r.entries.map((e) => e.epoch), [T + 4, T + 3, T + 2, T + 1].map(String), 'newest first');
  const first = r.entries.find((e) => e.epoch === String(T + 1));
  assert.deepStrictEqual(
    { status: first.status, params: first.params, errorClass: first.errorClass, waitMs: first.waitMs, gapMs: first.gapMs, sameCaller: first.sameCaller },
    { status: 'success', params: '{"to":"0xusdc","data":"0xaa"},0x18f0564', errorClass: 'ok', waitMs: 40, gapMs: 11, sameCaller: true },
    'status, params and error class from its own cache line');
  const unmatched = r.entries.find((e) => e.epoch === String(T + 4));
  assert.deepStrictEqual([unmatched.status, unmatched.params, unmatched.errorClass], ['', '', null]);
  assert.deepStrictEqual(r.methods, ['eth_call', 'eth_getBalance']);

  // ---- the page's filters
  assert.deepStrictEqual(page('filter=success').entries.map((e) => e.epoch), [T + 3, T + 1].map(String), 'success: ok only (a caller error is not success)');
  assert.strictEqual(page('filter=error').total, 0, 'our failures are never shared, so none here');
  assert.strictEqual(page('filter=warning').total, 0);
  assert.deepStrictEqual(page('filter=no-client').entries.map((e) => e.epoch), [T + 4, T + 2, T + 1].map(String), 'no-client drops buidlguidl-client');
  // ---- method and search (origin, IP, method, params, status)
  assert.strictEqual(page('filter=all&method=eth_getBalance').total, 1);
  assert.strictEqual(page('filter=all&q=APP.example').total, 1, 'origin, any case');
  assert.strictEqual(page('filter=all&q=0xbb').total, 1, 'params from the cache line');
  assert.strictEqual(page('filter=all&q=reverted').total, 1, 'status from the cache line');
  assert.strictEqual(page('filter=all&q=203.0.113').total, 2, 'IP');
  // ---- paging
  r = JSON.parse(service.respond('/mergedRequests?page=2&limit=3&filter=all').body);
  assert.deepStrictEqual([r.total, r.page, r.entries.length], [4, 2, 1]);
  assert.strictEqual(service.respond('/mergedRequests?page=0').statusCode, 400);
  // ---- unpaged route answers too
  assert.strictEqual(JSON.parse(service.respond('/mergedRequests').body).length, 4);

  // ---- a cache line that arrives after its merged line: matched on the next tick
  fs.appendFileSync(path.join(dir, 'cacheRequests.log'), cache(T + 4, '', '203.0.113.8', 'eth_call', '{"to":"0x1"},0x18f0564', 7, 'success'));
  await service.tick();
  assert.strictEqual(page('filter=all').entries[0].status, 'success', 'rebuilt when the cache log changes');

  // ---- the line parser
  assert.deepStrictEqual(parseMergedLogLine('m1|t|1791493451248|a%7Cb|1.2.3.4|eth_call|40|1791493451227|0'),
    { timestamp: 't', epoch: '1791493451248', requester: 'a|b', ip: '1.2.3.4', method: 'eth_call', waitMs: 40, leaderEpoch: '1791493451227', sameCaller: false });
  for (const bad of ['m1|t|1|a|b|c|1|1|1', 'v2|t|1791493451248|a|b|c|d|1|success', 'm1|t|1791493451248|a|b|c|x|1791493451227|1', 'm1|t|1791493451248|a|b|c|1|1791493451227|2']) {
    assert.strictEqual(parseMergedLogLine(bad), null, bad);
  }

  console.log = log;
  console.log('mergedRequests: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
