// Hourly pool request time percentiles (dashboard): successful pool requests only, summarized per
// hour once a line two hours newer arrives; the hour in progress computed fresh.
// Run: node test/poolTimeHistory.test.js
const assert = require('assert');
const { createPoolTimeHistory, recordPoolTime, prunePoolTimeHistory, poolTimeHistoryForDashboard } = require('../utils/metricsCalculators');
const { getStartOfHour } = require('../utils/timeUtils');

const HOUR = 60 * 60 * 1000;
const NOW = getStartOfHour(Date.now()) + 30 * 60 * 1000; // half past the current hour
const CUR = getStartOfHour(NOW);
const ok = (hourMs, elapsed, min = 1) => ({ epoch: String(hourMs + min * 60 * 1000), elapsed, status: 'success' });

// ---- only successful requests count
{
  const h = createPoolTimeHistory();
  recordPoolTime(h, ok(CUR, 50));
  recordPoolTime(h, { epoch: String(CUR + 1000), elapsed: 9, status: '{"jsonrpc":"2.0","error":{"code":3,"message":"execution reverted"}}' });
  recordPoolTime(h, { epoch: String(CUR + 1000), elapsed: 3000, status: '{"jsonrpc":"2.0","error":{"code":-69005,"message":"Node timed out"}}' });
  recordPoolTime(h, { epoch: 'garbage', elapsed: 5, status: 'success' });
  recordPoolTime(h, { epoch: String(CUR + 1000), elapsed: 'NaN', status: 'success' });
  const { poolTimeCurrentHour } = poolTimeHistoryForDashboard(h, NOW);
  assert.deepStrictEqual(poolTimeCurrentHour, { hourMs: CUR, n: 1, p5: 50, p25: 50, p50: 50, p75: 50, p95: 50 });
}

// ---- percentiles: 1..100 ms in one hour (nearest-rank, as the other dashboard percentiles)
{
  const h = createPoolTimeHistory();
  const shuffled = Array.from({ length: 100 }, (_, i) => i + 1).sort((a, b) => ((a * 37) % 100) - ((b * 37) % 100));
  for (const ms of shuffled) recordPoolTime(h, ok(CUR - 3 * HOUR, ms));
  recordPoolTime(h, ok(CUR, 10)); // two hours newer: the first hour is summarized
  assert.ok(!h.open.has(CUR - 3 * HOUR) && h.done.has(CUR - 3 * HOUR), 'summarized once a line two hours newer arrives');
  assert.deepStrictEqual(h.done.get(CUR - 3 * HOUR), { hourMs: CUR - 3 * HOUR, n: 100, p5: 5, p25: 25, p50: 50, p75: 75, p95: 95 });
}

// ---- out of order around the hour boundary: the previous hour stays open; completed hours sorted
{
  const h = createPoolTimeHistory();
  recordPoolTime(h, ok(CUR - 2 * HOUR, 100, 59));
  recordPoolTime(h, ok(CUR - HOUR, 20, 0));
  recordPoolTime(h, ok(CUR - 2 * HOUR, 300, 59)); // late by a minute: still counted
  recordPoolTime(h, ok(CUR, 7));                  // now CUR - 2h is summarized (2 hours older)
  recordPoolTime(h, ok(CUR - 2 * HOUR, 999, 59)); // more than an hour late: ignored
  const { poolTimeHistory, poolTimeCurrentHour } = poolTimeHistoryForDashboard(h, NOW);
  assert.deepStrictEqual(poolTimeHistory.map((x) => [x.hourMs, x.n, x.p95]), [[CUR - 2 * HOUR, 2, 300], [CUR - HOUR, 1, 20]],
    'completed hours, sorted, including the still-open previous hour');
  assert.strictEqual(poolTimeCurrentHour.n, 1);
  assert.ok(h.open.has(CUR - HOUR), 'the previous hour is computed for the dashboard without being closed');
}

// ---- no successful request yet this hour; pruning keeps the newest hours
{
  const h = createPoolTimeHistory();
  for (let i = 10; i >= 1; i--) recordPoolTime(h, ok(CUR - i * HOUR, i));
  assert.strictEqual(poolTimeHistoryForDashboard(h, NOW).poolTimeCurrentHour, null);
  prunePoolTimeHistory(h, 3);
  assert.deepStrictEqual(poolTimeHistoryForDashboard(h, NOW).poolTimeHistory.map((x) => x.hourMs), [CUR - 3 * HOUR, CUR - 2 * HOUR, CUR - HOUR]);
}

console.log('poolTimeHistory: all passed');
