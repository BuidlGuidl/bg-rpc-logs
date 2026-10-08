// Parser for poolRequests.log, cacheRequests.log and fallbackRequests.log lines. Two formats:
//
//   v2 (bg-rpc-proxy utils/requestLogFormat.js; keep the two in step):
//     v2|timestamp|epoch|origin|ip|method|params|elapsed|status
//     Always exactly 9 fields: origin, ip, method, params and status are escaped on write
//     (% → %25, | → %7C, \n → %0A, \r → %0D), unescaped here in one pass.
//   legacy (before the ip column; lines start with the timestamp):
//     timestamp|epoch|origin|method|params|elapsed|status
//     Nothing was escaped, so a '|' in any field shifts the rest. Read from both ends: the first
//     fields from the left, elapsed and status from the right, params is what's left between. A
//     line some old tooling (shared/addIpColumn.js, May 2025) gave an empty field after origin is
//     read with that field as the ip.
//
// A line that can't be read with confidence returns null and is skipped, never guessed at:
// a v2 line without 9 fields, legacy fragments (a raw newline in a param split one request into
// two lines), or a legacy line whose method, epoch or elapsed doesn't look right.

const EPOCH = /^\d{10,16}$/;
const ELAPSED = /^\d+(\.\d+)?$/;
// JSON-RPC method names: namespace_method (eth_call, net_version, web3_clientVersion...)
const METHOD = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/;

function unescapeField(value) {
  return value.replace(/%(25|7C|0A|0D)/g, (m) => ({ '%25': '%', '%7C': '|', '%0A': '\n', '%0D': '\r' })[m]);
}

/**
 * @param {string} line - one line, without its newline
 * @returns {{ format: 'v2'|'legacy', timestamp: string, epoch: string, requester: string, ip: string,
 *   method: string, params: string, elapsed: number, status: string } | null}
 */
function parseRequestLogLine(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  const parts = line.split('|');

  if (parts[0] === 'v2') {
    if (parts.length !== 9) return null;
    const [, timestamp, epoch, origin, ip, method, params, elapsed, status] = parts;
    if (!EPOCH.test(epoch)) return null;
    return {
      format: 'v2',
      timestamp,
      epoch,
      requester: unescapeField(origin),
      ip: unescapeField(ip),
      method: unescapeField(method),
      params: unescapeField(params),
      elapsed: parseFloat(elapsed),
      status: unescapeField(status),
    };
  }

  // legacy
  if (parts.length < 7) return null;
  const [timestamp, epoch] = parts;
  if (!EPOCH.test(epoch)) return null;
  const n = parts.length;
  const status = parts[n - 1];
  const elapsed = parts[n - 2];
  if (!ELAPSED.test(elapsed)) return null;

  // An empty field right after origin, then the method: a line padded by shared/addIpColumn.js
  if (parts[3] === '' && n >= 8 && METHOD.test(parts[4])) {
    return {
      format: 'legacy', timestamp, epoch, requester: parts[2], ip: '',
      method: parts[4], params: parts.slice(5, n - 2).join('|'), elapsed: parseFloat(elapsed), status,
    };
  }
  // The method is the first field after the timestamp and epoch that looks like one; anything
  // before it is the origin (a '|' inside an old origin header)
  let m = 3;
  while (m < n - 2 && !METHOD.test(parts[m])) m++;
  if (m >= n - 2) return null;
  return {
    format: 'legacy',
    timestamp,
    epoch,
    requester: parts.slice(2, m).join('|'),
    ip: '',
    method: parts[m],
    params: parts.slice(m + 1, n - 2).join('|'),
    elapsed: parseFloat(elapsed),
    status,
  };
}

/**
 * A mergedRequests.log line (bg-rpc-proxy utils/requestLogFormat.js formatMergedLine; keep the two
 * in step): a request answered by sharing an identical request already in flight.
 *
 *   m1|timestamp|epoch|origin|ip|method|waitMs|leaderEpoch|sameCaller
 *
 * Always exactly 9 fields; origin, ip and method escaped as in v2. Anything else returns null.
 * @returns {{ timestamp, epoch, requester, ip, method, waitMs: number, leaderEpoch: string,
 *   sameCaller: boolean } | null}
 */
function parseMergedLogLine(line) {
  if (typeof line !== 'string') return null;
  const parts = line.split('|');
  if (parts[0] !== 'm1' || parts.length !== 9) return null;
  const [, timestamp, epoch, origin, ip, method, waitMs, leaderEpoch, sameCaller] = parts;
  if (!EPOCH.test(epoch) || !EPOCH.test(leaderEpoch) || !/^\d+$/.test(waitMs) || !/^[01]$/.test(sameCaller)) return null;
  return {
    timestamp,
    epoch,
    requester: unescapeField(origin),
    ip: unescapeField(ip),
    method: unescapeField(method),
    waitMs: Number(waitMs),
    leaderEpoch,
    sameCaller: sameCaller === '1',
  };
}

module.exports = { parseRequestLogLine, parseMergedLogLine, unescapeField };
