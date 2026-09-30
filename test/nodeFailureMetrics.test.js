// Node rating (percentTimeout, read by the pool's D13 slow switch): what counts as a failure.
// Run: node test/nodeFailureMetrics.test.js
const assert = require('assert');
const { getStartOfHour } = require('../utils/timeUtils');
const { calculateNodeTimeoutMetrics, recordNodeTimeoutSample, pruneNodeTimeoutCounts, isNodeFailureStatus } = require('../utils/metricsCalculators');

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
const add = (k, nodeId, status) => recordNodeTimeoutSample(cache, String(now - 1000), nodeId, 'o', status);
for (let i = 0; i < 6; i++) add(`a${i}`, 'broken-node', '{"code":-70000,"message":"Internal node error"}');
for (let i = 0; i < 4; i++) add(`b${i}`, 'broken-node', 'success');
for (let i = 0; i < 10; i++) add(`c${i}`, 'healthy-node', i < 2 ? '{"code":3,"message":"execution reverted"}' : 'success');
add('d', 'healthy-node', 'timeout_error_heavy');
const m = Object.fromEntries(calculateNodeTimeoutMetrics(cache, 'week').map((x) => [x.nodeId, x.percentTimeout]));
assert.strictEqual(m['broken-node'], 0.6, 'a node failing instantly with -70000 is rated as failing');
assert.strictEqual(m['healthy-node'], 0, 'reverts and heavy timeouts do not count');

// Hourly counters: the window is whole hours, older hours are pruned
const HOUR = 60 * 60 * 1000;
const counts = new Map();
const thisHour = getStartOfHour(now);
recordNodeTimeoutSample(counts, String(thisHour + 1), 'n', 'o', 'success');
recordNodeTimeoutSample(counts, String(thisHour + 2), 'n', 'o', 'timeout_error');
recordNodeTimeoutSample(counts, String(now - 2 * 24 * HOUR), 'n', 'o', 'timeout_error'); // in the week, not the day
recordNodeTimeoutSample(counts, String(now - 8 * 24 * HOUR), 'n', 'o', 'timeout_error'); // older than a week
recordNodeTimeoutSample(counts, 'not-a-number', 'n', 'o', 'timeout_error'); // unreadable epoch: ignored
assert.strictEqual(counts.size, 3, 'one bucket per node-hour');
assert.deepStrictEqual(counts.get(`n|${thisHour}`), { nodeId: 'n', owner: 'o', hourMs: thisHour, total: 2, failures: 1 });
assert.strictEqual(calculateNodeTimeoutMetrics(counts, 'day')[0].percentTimeout, 0.5);
assert.strictEqual(calculateNodeTimeoutMetrics(counts, 'week')[0].percentTimeout, 2 / 3);
assert.strictEqual(pruneNodeTimeoutCounts(counts, now), 1, 'the hour older than a week is pruned');
assert.strictEqual(counts.size, 2);
console.log('nodeFailureMetrics: all passed');
