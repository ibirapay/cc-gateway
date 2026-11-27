/**
 * Circuit breaker streak semantics (2026-11-26): a success clears the
 * consecutive-failure count, so scattered timeouts inside a run of successes
 * must NOT open the breaker — but 5 consecutive failures still do.
 * Run: npx tsx tests/circuit-breaker.test.ts
 */
import assert from 'node:assert'
import { isOpen, recordFailure, recordSuccess } from '../src/circuit-breaker.js'

assert.equal(isOpen(), false, 'breaker starts closed')

// 4 failures, a success, 4 more failures: the old code opened the breaker here
// (successes only cleared the count after the 30 s window expired).
for (let i = 0; i < 4; i++) recordFailure('timeout 1-4')
recordSuccess()
for (let i = 0; i < 4; i++) recordFailure('timeout 5-8')
assert.equal(isOpen(), false, 'successes must break the failure streak')

// 5 consecutive failures with no success in between: open.
for (let i = 0; i < 5; i++) recordFailure('dead upstream')
assert.equal(isOpen(), true, '5 consecutive failures must open the breaker')

console.log('circuit-breaker.test: OK')
