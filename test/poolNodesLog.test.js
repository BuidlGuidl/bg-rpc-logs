// parsePoolNodesLog: one pass fills the node map, the timing map and the timeout counters.
// Run: node test/poolNodesLog.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePoolNodesLog, pruneOldest } = require('../utils/logParsers');
const { maxTimingEntriesPerNode } = require('../config');

const file = path.join(os.tmpdir(), `poolnodes-${process.pid}.log`);
const now = Date.now();
const line = (i, nodeId, duration, status = 'success') =>
  `2026-09-30 12:00:00|${now - 1000 + i}|${nodeId}|owner-${nodeId}|eth_call|{"to":"0x1"},latest|${duration}|${status}`;

(async () => {
  // ---- pruneOldest keeps the most recently inserted entries
  const m = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  pruneOldest(m, 2);
  assert.deepStrictEqual([...m.keys()], ['c', 'd']);

  const nodes = new Map(); const timing = new Map(); const counts = new Map();
  const idx = { poolNodes: -1 }; const offsets = { poolNodes: 0 };
  const parse = () => parsePoolNodesLog(file, nodes, timing, counts, idx, offsets, 5);

  // ---- first read: the whole file for timing and counts, the last 5 lines for the node map
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push(line(i, i % 2 ? 'node-b' : 'node-a', 10 + i, i === 3 ? 'timeout_error' : 'success'));
  lines.push('');                                         // blank line: counted, not stored
  lines.push(`2026-09-30 12:00:00|${now}|1790000000000|x`); // shifted line: stored, no timing (nodeId is an epoch)
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.strictEqual(await parse(), true);
  assert.deepStrictEqual([...nodes.values()].map((e) => e.lineIndex), [5, 6, 7, 9], 'the last 5 lines (one blank), real line numbers');
  assert.deepStrictEqual(timing.get('node-a'), [10, 12, 14, 16]);
  assert.deepStrictEqual(timing.get('node-b'), [11, 13, 15, 17]);
  assert.strictEqual(timing.has('1790000000000'), false);
  const b = [...counts.values()].find((c) => c.nodeId === 'node-b');
  assert.deepStrictEqual([b.total, b.failures, b.owner], [4, 1, 'owner-node-b']);
  assert.strictEqual(offsets.poolNodes, fs.statSync(file).size);

  // ---- nothing new: no change
  assert.strictEqual(await parse(), false);

  // ---- incremental: only appended lines; an unfinished last line waits for its newline
  fs.appendFileSync(file, line(20, 'node-a', 99) + '\n' + line(21, 'node-a', 98).slice(0, 30));
  assert.strictEqual(await parse(), true);
  assert.deepStrictEqual(timing.get('node-a'), [10, 12, 14, 16, 99]);
  assert.strictEqual([...nodes.values()].pop().lineIndex, 10);
  fs.appendFileSync(file, line(21, 'node-a', 98).slice(30) + '\n');
  assert.strictEqual(await parse(), true);
  assert.deepStrictEqual(timing.get('node-a'), [10, 12, 14, 16, 99, 98], 'the finished line is read whole, once');
  assert.strictEqual([...nodes.values()].pop().lineIndex, 11);
  assert.strictEqual(nodes.size, 5);

  // ---- timing arrays are capped per node
  fs.appendFileSync(file, Array.from({ length: maxTimingEntriesPerNode + 5 }, (_, i) => line(i, 'node-c', i)).join('\n') + '\n');
  await parse();
  assert.strictEqual(timing.get('node-c').length, maxTimingEntriesPerNode);
  assert.strictEqual(timing.get('node-c')[0], 5, 'oldest dropped');

  // ---- rotation: everything is cleared and the new file read from the start
  fs.writeFileSync(file, line(0, 'node-z', 1) + '\n');
  assert.strictEqual(await parse(), true);
  assert.deepStrictEqual([...timing.keys()], ['node-z']);
  assert.deepStrictEqual([...nodes.values()].map((e) => [e.nodeId, e.lineIndex]), [['node-z', 0]]);
  assert.deepStrictEqual([...counts.values()].map((c) => c.nodeId), ['node-z']);

  fs.unlinkSync(file);
  console.log('poolNodesLog: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
