// Run: node test/fileUtils.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findTailStart, readLines } = require('../utils/fileUtils');

const file = path.join(os.tmpdir(), `fileutils-${process.pid}.log`);

// Reference: lines as split('\n'), a final line without a newline counts
function expectedTail(content, n) {
  const lines = content.split('\n');
  const total = content === '' || content.endsWith('\n') ? lines.length - 1 : lines.length;
  if (total <= n) return { startByte: 0, startLine: 0, totalLines: total };
  const startLine = total - n;
  return { startByte: Buffer.byteLength(lines.slice(0, startLine).join('\n') + '\n'), startLine, totalLines: total };
}

(async () => {
  // ---- findTailStart: edge cases, multibyte text, and chunk boundaries (lines longer than the 64 KB read size)
  const cases = [
    '', 'a', 'a\n', '\n', '\n\n\n', 'a\nb\nc\n', 'a\nb\nc', 'é\nü\n€\n', 'x\n\ny\n\n',
    Array.from({ length: 50 }, (_, i) => `${i}|${'z'.repeat(i * 3000)}`).join('\n') + '\n',
  ];
  for (const content of cases) {
    fs.writeFileSync(file, content);
    for (const n of [1, 2, 3, 10, 49, 50, 51]) {
      assert.deepStrictEqual(await findTailStart(file, n), expectedTail(content, n), `content ${JSON.stringify(content.slice(0, 20))} n ${n}`);
    }
  }

  // ---- readLines: complete lines only; an unfinished last line is left for the next read
  fs.writeFileSync(file, 'one\ntwo\nthr');
  let lines = [];
  let offset = await readLines(file, 0, (l) => lines.push(l));
  assert.deepStrictEqual(lines, ['one', 'two']);
  assert.strictEqual(offset, 8);
  fs.appendFileSync(file, 'ee\nfour\n');
  lines = [];
  offset = await readLines(file, offset, (l) => lines.push(l));
  assert.deepStrictEqual(lines, ['three', 'four']);
  assert.strictEqual(offset, fs.statSync(file).size);
  // a line spanning several read chunks, multibyte characters across a chunk boundary
  const long = '€'.repeat(100000);
  fs.writeFileSync(file, `a\n${long}\nb\n`);
  lines = [];
  await readLines(file, 0, (l) => lines.push(l));
  assert.deepStrictEqual(lines, ['a', long, 'b']);

  fs.unlinkSync(file);
  console.log('fileUtils: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
