// Dashboard error classes: only our failures are errors. Run: node test/errorClass.test.js
const assert = require('assert');
const { classifyStatus } = require('../utils/errorClass');
const s = (code, message) => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: 1 });

// the caller's mistakes (seen in the 2026-09-29 audit runs): not errors
for (const [code, msg] of [[-32000, 'nonce too low: next nonce 551651, tx nonce 55'], [-32003, 'EVM error: OutOfFunds'],
  [-32001, 'block not found: 0x18e0873'], [-32000, 'header not found'], [-32000, 'failed with 16777216 gas: insufficient funds for gas * price + value'],
  [-32000, 'transaction gas price below minimum: gas tip cap 0, minimum needed 1'], [3, 'execution reverted'], [-32602, 'Invalid params'],
  [-32601, 'the method eth_getAccount does not exist/is not available'], [-32005, 'eth_getLogs capacity exhausted, retry shortly']]) {
  assert.strictEqual(classifyStatus(s(code, msg)), 'caller', `${code} ${msg}`);
}
// our nodes lack the data or timed out: warnings
assert.strictEqual(classifyStatus(s(4444, 'pruned history unavailable: requested 1, earliest available 15500000')), 'warning');
assert.strictEqual(classifyStatus(s(-32000, 'historical state 1dddf24a is not available')), 'warning');
assert.strictEqual(classifyStatus(s(-32002, 'request timed out')), 'warning');
assert.strictEqual(classifyStatus(s(-69005, 'Node timed out')), 'warning');
assert.strictEqual(classifyStatus(s(-69000, 'No clients connected to pool')), 'warning');
// ours: errors
assert.strictEqual(classifyStatus(s(-70000, 'Internal node error')), 'error');
assert.strictEqual(classifyStatus(s(-70000, 'Internal Proxy service error')), 'error');
assert.strictEqual(classifyStatus(s(-70002, 'Invalid response from node (missing result and error)')), 'error');
assert.strictEqual(classifyStatus('not json at all'), 'error');
assert.strictEqual(classifyStatus(JSON.stringify({ jsonrpc: '2.0', id: 1 })), 'error');
// a bare error object (no jsonrpc wrapper) is read too
assert.strictEqual(classifyStatus(JSON.stringify({ code: -32001, message: 'block not found: 0x1' })), 'caller');
assert.strictEqual(classifyStatus('success'), 'ok');
console.log('errorClass: all passed');
