// Node rating (percentTimeout, read by the pool's D13 slow switch): what counts as a failure.
// Run: node test/nodeFailureMetrics.test.js
const assert = require('assert');
const { calculateNodeTimeoutMetrics, isNodeFailureStatus } = require('../utils/metricsCalculators');

assert.strictEqual(isNodeFailureStatus('timeout_error'), true);
assert.strictEqual(isNodeFailureStatus('{"code":-70000,"message":"Internal node error"}'), true);
assert.strictEqual(isNodeFailureStatus('{"code":-70000,"message":"Internal node error","data":"connect ECONNREFUSED 127.0.0.1:8545"}'), true);
assert.strictEqual(isNodeFailureStatus('timeout_error_heavy'), false, 'getLogs timeouts stay out');
assert.strictEqual(isNodeFailureStatus('success'), false);
assert.strictEqual(isNodeFailureStatus('{"code":3,"message":"execution reverted"}'), false, 'a revert is the answer, not a failure');
assert.strictEqual(isNodeFailureStatus('{"code":-32602,"message":"Invalid params"}'), false);
assert.strictEqual(isNodeFailureStatus('{"code":-700001,"message":"x"}'), false, 'exact code only');

const now = Date.now();
const cache = new Map();
const add = (k, nodeId, status) => cache.set(k, { epoch: String(now - 1000), nodeId, owner: 'o', status });
for (let i = 0; i < 6; i++) add(`a${i}`, 'broken-node', '{"code":-70000,"message":"Internal node error"}');
for (let i = 0; i < 4; i++) add(`b${i}`, 'broken-node', 'success');
for (let i = 0; i < 10; i++) add(`c${i}`, 'healthy-node', i < 2 ? '{"code":3,"message":"execution reverted"}' : 'success');
add('d', 'healthy-node', 'timeout_error_heavy');
const m = Object.fromEntries(calculateNodeTimeoutMetrics(cache, 'week').map((x) => [x.nodeId, x.percentTimeout]));
assert.strictEqual(m['broken-node'], 0.6, 'a node failing instantly with -70000 is rated as failing');
assert.strictEqual(m['healthy-node'], 0, 'reverts and heavy timeouts do not count');
console.log('nodeFailureMetrics: all passed');
