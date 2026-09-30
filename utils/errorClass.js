const { ignoredErrorCodes } = require('../../shared/ignoredErrorCodes');

// Error classes for the dashboard and the logs page: only OUR failures are errors (owner,
// 2026-09-29). The one copy (bg-rpc-docs LOGS_SERVICE_OPTIMIZATION_PLAN.md, decision D1): the
// logs page gets each entry's class from this service. Mirrors bg-rpc-proxy/utils/fallbackPolicy.js,
// the rule for what goes to the fallback: a JSON-RPC error a node answered to the caller's request
// is the caller's mistake, and fails on any provider (nonce too low, OutOfFunds, block not found
// for a future block, a method the client doesn't implement...). Those used to count as pool
// errors (66 in one hour of audit tests, none of them a real failure).
//
//   'ok'       success
//   'caller'   the node's answer to a bad request: not an error
//   'warning'  our nodes lack the data or timed out (pool/proxy -69xxx, timeouts, "pruned", geth
//              "historical state ... not available"): bg-rpc-proxy sends these to the fallback,
//              so request-log ones also show in the fallback counts
//   'error'    ours: a node's -70000 "Internal node error", the pool's -70001 / -70002, the
//              proxy's -70000 (pool or fallback unreachable), a broken node socket or response,
//              or anything unreadable
//
// Statuses come in three shapes: 'success', a plain word from the pool's node log
// (timeout_error, timeout_error_heavy, socket_error, invalid_format, invalid_response), or a
// JSON error (a full JSON-RPC response or a bare { code, message }).
//
// "block not found" / "header not found" count as the caller's even when our nodes were
// lagging: in that case bg-rpc-proxy fell back and the request shows in the fallback count
// (known gap; plan item 8).

const MISSING_HISTORY = /pruned|history unavailable|historical state .*not available|missing trie node/i;
const NODE_TIMEOUT = /timed? ?out/i;

function classifyStatus(status) {
  if (typeof status === 'number') return ignoredErrorCodes.includes(status) ? 'caller' : 'error';
  if (typeof status !== 'string') return 'error';
  const s = status.trim();
  if (s.toLowerCase() === 'success') return 'ok';
  if (/^timeout/i.test(s)) return 'warning';
  if (/^(socket_error|invalid_format|invalid_response)$/i.test(s)) return 'error';
  if (/^-?\d+$/.test(s)) return ignoredErrorCodes.includes(Number(s)) ? 'caller' : 'error';
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return 'error';
  }
  const err = obj && typeof obj === 'object' ? (obj.error ?? obj) : null;
  const code = err && typeof err === 'object' ? Number(err.code) : NaN;
  if (!Number.isFinite(code)) return 'error';
  if (ignoredErrorCodes.includes(code)) return 'caller';
  if (code <= -69000) return String(code).startsWith('-69') ? 'warning' : 'error';
  const message = typeof err.message === 'string' ? err.message : '';
  if (MISSING_HISTORY.test(message) || NODE_TIMEOUT.test(message)) return 'warning';
  return 'caller';
}

module.exports = { classifyStatus };
