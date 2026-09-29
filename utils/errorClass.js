const { ignoredErrorCodes } = require('../../shared/ignoredErrorCodes');

// Dashboard error counting: only OUR failures are errors (owner, 2026-09-29).
// Mirrors bg-rpc-proxy/utils/fallbackPolicy.js, the rule for what goes to the fallback: a
// JSON-RPC error a node answered to the caller's request is the caller's mistake, and fails
// on any provider (nonce too low, OutOfFunds, block not found for a future block, a method
// the client doesn't implement...). Those used to count as pool errors (66 in one hour of
// audit tests, none of them a real failure).
//
//   'ok'       success
//   'caller'   the node's answer to a bad request: not an error on the dashboard
//   'warning'  our nodes lack the data or timed out (pool/proxy -69xxx, "pruned", geth
//              "historical state ... not available", node timeouts): bg-rpc-proxy sends
//              these to the fallback, so they also show in the fallback counts
//   'error'    ours: a node's -70000 "Internal node error", the pool's -70001 / -70002,
//              the proxy's -70000 (pool or fallback unreachable), or anything unreadable
//
// "block not found" / "header not found" count as the caller's even when our nodes were
// lagging: in that case bg-rpc-proxy fell back and the request shows in the fallback count.

const MISSING_HISTORY = /pruned|history unavailable|historical state .*not available|missing trie node/i;
const NODE_TIMEOUT = /timed? ?out/i;

function classifyStatus(status) {
  if (status === 'success') return 'ok';
  let obj;
  try {
    obj = JSON.parse(status);
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
