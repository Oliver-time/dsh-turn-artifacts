/**
 * Regression guard for the history-autofill switch.
 *
 * The fill is ON, and that is load-bearing: the client opens a conversation with
 * only its newest 50 events, so a turn whose tool output produced a file is
 * outside the window in any long conversation. Without the fill the plugin never
 * sees that evidence, and historical file mentions silently stop being links —
 * which is exactly the regression a disabled fill caused once already.
 *
 * So "does `apply()` still subscribe and page?" is the thing that must never
 * silently regress. Turning the fill off is a legitimate choice, but it has a
 * user-visible cost, and this check makes that cost a decision rather than an
 * accident.
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

check('apply() subscribes to the session list so history can be paged', () => {
  const ctx = probingContext()
  exported.apply(ctx)
  assert.equal(ctx.subscriptions, 1, 'the fill must subscribe; without it, evidence outside the 50-event window is invisible')
  // Opening happens on the subscription's first notification, which is a later
  // microtask; `history autofill pages an opened session back to the start` in
  // harness.mjs covers the paging itself.
})

check('the fill pages a session back to the start', async () => {
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
  assert.equal(await exported.fillHistory(sessions, 'session-1', 5), 2, 'every remaining page is pulled')
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
