/**
 * Regression guard for the history-autofill switch.
 *
 * The fill is off by default because it wrecked large sessions (see the
 * `HISTORY_AUTOFILL_ENABLED` doc comment in `lib/client.js`). That makes "does
 * `apply()` still subscribe to the session list?" the one thing that must never
 * silently regress: if the switch is flipped back on by accident, this check
 * fails and says so.
 *
 * Run with: node test/autofill-off.mjs
 *
 * @module test/autofill-off
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let registration
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
new Function(readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8'))()
const exported = registration.factory((spec) => {
  if (spec === 'react') return { createElement: () => ({}), useEffect() {} }
  throw new Error(`unexpected require(${spec})`)
})

/** A context that records every subscription the plugin makes. */
function probingContext() {
  const ctx = {
    subscriptions: 0,
    opens: 0,
  }
  ctx.uiConversation = { events: { register: () => () => {} } }
  ctx.slots = { inject() {}, register: () => () => {} }
  ctx.get = () => undefined
  ctx.on = () => {}
  ctx.effect = (factory) => {
    const disposer = factory()
    if (typeof disposer === 'function') disposer()
  }
  ctx.sessions = {
    list: {
      getSnapshot: () => ({ current: 'session-1' }),
      subscribe() {
        ctx.subscriptions += 1
        return () => {}
      },
    },
    binding: () => ({ session: { open: async () => { ctx.opens += 1 } } }),
    resolve: () => undefined,
  }
  ctx.remote = { $host: { isLoopback: true }, session: {} }
  return ctx
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('apply() does not subscribe to the session list while the fill is off', () => {
  const ctx = probingContext()
  exported.apply(ctx)
  assert.equal(ctx.subscriptions, 0, 'the session list must not be subscribed')
  assert.equal(ctx.opens, 0, 'no session may be opened by the plugin')
})

check('the fill still works when it is called explicitly', async () => {
  const session = {
    baseSeq: 100,
    hasMore: true,
    pages: 0,
    async open() {},
    async loadOlder() {
      this.pages += 1
      this.baseSeq -= 50
      if (this.pages >= 2) this.hasMore = false
    },
  }
  const sessions = { binding: () => ({ session }), list: {} }
  assert.equal(await exported.fillHistory(sessions, 'session-1', 5), 2, 'explicit paging is unaffected by the switch')
})

check('the plugin still mounts and exports its real surface', () => {
  for (const name of ['apply', 'inject', 'fillHistory', 'resolveToken', 'collectPaths']) {
    assert.ok(name in exported, `${name} must still be exported`)
  }
  assert.ok(Array.isArray(exported.inject))
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${String(checks.length - failed)}/${String(checks.length)} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
