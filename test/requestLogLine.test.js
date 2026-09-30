// Run: node test/requestLogLine.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseRequestLogLine } = require('../utils/requestLogLine');
const { parseLogFile } = require('../utils/logParsers');
const { maxParamsChars } = require('../config');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter((l) => l !== '');

// ---- legacy lines from stage (written 2026-09-29 by the pre-v2 bg-rpc-proxy)
const pool = fixture('legacy-poolRequests.log').map(parseRequestLogLine);
// fixture line order: see the requests sent to make them
const [bal, revert, logs, blk, gas, noOrigin, referer, pipeOrigin, pipeParam, nlHead, nlTail, pipeMethod, objPipe, poolDown] = pool;
assert.deepStrictEqual({ ...bal, elapsed: 0 }, { format: 'legacy', timestamp: '2026-09-29 18:04:01', epoch: '1790705041684',
  requester: 'https://fixture.buidlguidl.test', ip: '', method: 'eth_getBalance',
  params: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,0x1312d00', elapsed: 0, status: 'success' });
assert.strictEqual(bal.elapsed, 77.567);
assert.strictEqual(revert.method, 'eth_call'); assert.strictEqual(JSON.parse(revert.status).error.code, 3);
assert.strictEqual(logs.method, 'eth_getLogs');
assert.strictEqual(gas.method, 'eth_gasPrice'); assert.strictEqual(gas.params, '');
assert.strictEqual(noOrigin.requester, ''); assert.strictEqual(noOrigin.method, 'eth_getBalance');
assert.strictEqual(referer.requester, 'some.dapp.example');
assert.strictEqual(pipeOrigin.requester, 'https://evil|origin.example', "'|' in an old origin is rejoined");
assert.strictEqual(pipeOrigin.method, 'eth_getTransactionCount');
assert.strictEqual(pipeParam.params, '0xabc|def,0x18e05ba', "'|' in old params is rejoined");
assert.strictEqual(JSON.parse(pipeParam.status).error.code, -32602);
assert.strictEqual(nlHead, null, 'first half of a request split by a raw newline is skipped');
assert.strictEqual(nlTail, null, 'second half is skipped');
assert.strictEqual(pipeMethod, null, "'|' in an old method (echoed in its error status too) can't be read with confidence: skipped");
assert.ok(JSON.parse(objPipe.params.split('},')[0] + '}').note === 'a|b', "'|' inside an old JSON param");
assert.strictEqual(poolDown.method, 'eth_getBalance'); assert.strictEqual(JSON.parse(poolDown.status).error.code, -70000); // pool stopped: proxy couldn't reach it
assert.strictEqual(pool.length, 14);

const fb = fixture('legacy-fallbackRequests.log').map(parseRequestLogLine);
assert.strictEqual(fb[0].method, 'eth_getBalance'); assert.strictEqual(JSON.parse(fb[0].status).error.code, -70000);
const cache = fixture('legacy-cacheRequests.log').map(parseRequestLogLine);
assert.ok(cache.length === 20 && cache.every((e) => e && e.format === 'legacy' && e.method && Number.isFinite(e.elapsed)));

// ---- shared/addIpColumn.js-style legacy line: empty field after origin
const padded = parseRequestLogLine('2025-05-16 10:00:00|1747389600000|https://app.example||eth_call|{"to":"0x1"},latest|12.3|success');
assert.deepStrictEqual([padded.requester, padded.ip, padded.method, padded.params, padded.elapsed], ['https://app.example', '', 'eth_call', '{"to":"0x1"},latest', 12.3]);

// ---- v2 lines (bg-rpc-proxy utils/requestLogFormat.js)
const v2 = parseRequestLogLine('v2|2026-09-29 19:00:00|1790710000000|https://evil%7Corigin|203.0.113.7|eth_get%7CBalance|0xabc%7Cdef,0x1%0A2|12.5|{"error":{"message":"a%7Cb 100%25"}}');
assert.deepStrictEqual(v2, { format: 'v2', timestamp: '2026-09-29 19:00:00', epoch: '1790710000000', requester: 'https://evil|origin',
  ip: '203.0.113.7', method: 'eth_get|Balance', params: '0xabc|def,0x1\n2', elapsed: 12.5, status: '{"error":{"message":"a|b 100%"}}' });
assert.strictEqual(parseRequestLogLine('v2|t|1790710000000|o|-|eth_chainId||0.05|success').ip, '-');
assert.strictEqual(parseRequestLogLine('v2|t|1790710000000|o|1.2.3.4|eth_chainId||0.05'), null, 'v2 with 8 fields is malformed');
assert.strictEqual(parseRequestLogLine('v2|t|1790710000000|o|1.2.3.4|eth_chainId||0.05|success|extra'), null, 'v2 with 10 fields is malformed');
assert.strictEqual(parseRequestLogLine(''), null);

// ---- parseLogFile end to end on a file mixing both formats (as on prod right after the switch)
(async () => {
  const file = path.join(os.tmpdir(), `reqlog-${process.pid}.log`);
  const lines = [...fixture('legacy-poolRequests.log'),
    'v2|2026-09-29 19:00:00|1790710000000|https://app.example|203.0.113.7|eth_call|{"to":"0x1"},latest|12.5|success',
    'v2|2026-09-29 19:00:01|1790710001000|buidlguidl-client|-|eth_blockNumber||0.06|success',
    'v2|broken|line'];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const map = new Map(); const idx = { pool: -1 }; const offsets = { pool: 0 }; // as logs.js starts them
  await parseLogFile(file, map, 'pool', idx, offsets, 100000);
  const entries = [...map.values()];
  assert.strictEqual(entries.length, 14 - 3 + 2, 'legacy lines minus the 2 newline fragments and the pipe-in-method line, plus 2 good v2 lines');
  assert.strictEqual(offsets.pool, fs.statSync(file).size, 'byte offset covers every line, skipped ones too');
  const last = entries.find((e) => e.epoch === '1790710000000');
  assert.deepStrictEqual([last.requester, last.ip, last.method, last.elapsed], ['https://app.example', '203.0.113.7', 'eth_call', 12.5]);
  // incremental read: append one more v2 line, only it is added
  fs.appendFileSync(file, 'v2|2026-09-29 19:00:02|1790710002000|o|198.51.100.2|eth_chainId||0.04|success\n');
  await parseLogFile(file, map, 'pool', idx, offsets, 100000);
  assert.strictEqual(map.size, 14);
  // line numbers stay right after skipped lines: the new entry's key uses its real line number
  const lastKey = [...map.keys()].find((k) => k.startsWith('1790710002000-'));
  assert.strictEqual(lastKey, `1790710002000-${lines.length}`);
  assert.ok([...map.values()].some((e) => e.ip === '198.51.100.2'));
  // params longer than maxParamsChars are stored cut, with their full length noted
  const calldata = '0x82ad56cb' + '0'.repeat(8000);
  fs.appendFileSync(file, `v2|2026-09-29 19:00:03|1790710003000|o|198.51.100.2|eth_call|{"data":"${calldata}"},latest|70|success\n`);
  await parseLogFile(file, map, 'pool', idx, offsets, 100000);
  const multicall = [...map.values()].find((e) => e.epoch === '1790710003000');
  const fullLength = `{"data":"${calldata}"},latest`.length;
  assert.strictEqual(multicall.params, `{"data":"${calldata}`.slice(0, maxParamsChars) + `… (${fullLength} chars)`);
  assert.strictEqual(multicall.status, 'success');
  fs.unlinkSync(file);
  console.log('requestLogLine: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
