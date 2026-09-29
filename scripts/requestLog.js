#!/usr/bin/env node
// Print poolRequests / cacheRequests / fallbackRequests log lines as one set of tab-separated
// columns, whichever format each line is in (legacy or v2; utils/requestLogLine.js), so raw
// files can be read with cut/awk/grep without knowing where the format changed:
//
//   timestamp  epoch  origin  ip  method  elapsed  status  params
//
//   node scripts/requestLog.js ~/shared/fallbackRequests.log | cut -f5 | sort | uniq -c
//   tail -f ~/shared/poolRequests.log | node scripts/requestLog.js
// Lines that can't be read are reported on stderr and skipped.
const fs = require('fs');
const readline = require('readline');
const { parseRequestLogLine } = require('../utils/requestLogLine');

const input = process.argv[2] ? fs.createReadStream(process.argv[2]) : process.stdin;
const clean = (s) => String(s ?? '').replace(/[\t\n\r]/g, ' ');
let skipped = 0;
readline.createInterface({ input, crlfDelay: Infinity })
  .on('line', (line) => {
    if (!line.trim()) return;
    const e = parseRequestLogLine(line);
    if (!e) { skipped++; process.stderr.write(`skipped: ${line.slice(0, 120)}\n`); return; }
    process.stdout.write([e.timestamp, e.epoch, e.requester, e.ip, e.method, e.elapsed, e.status, e.params].map(clean).join('\t') + '\n');
  })
  .on('close', () => { if (skipped) process.stderr.write(`${skipped} line(s) skipped\n`); });
