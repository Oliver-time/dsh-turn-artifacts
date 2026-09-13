/**
 * Proves the mid-turn regression check in `harness.mjs` actually fails on the
 * bug it was written for.
 *
 * It loads the client bundle twice: once as shipped, once with the undefined-phase
 * guard stripped out (the shape of the original defect), and reports whether each
 * one throws when an update-role match arrives before any turn was seeded. A
 * regression check that cannot fail is not a regression check.
 *
 * Run with: node test/regression-probe.mjs
 *
 * @module test/regression-probe
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const GUARD = 'if (phase === void 0 || phase === null) return phase;'

/** Load one bundle source and return the conversation definition it registers. */
function definitionOf(code) {
  let registration
  globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
  new Function(code)()
  const exported = registration.factory((spec) => {
    if (spec === 'react') return { createElement: () => ({}), useEffect() {} }
    throw new Error(`unexpected require(${spec})`)
  })
  let definition
  const ctx = {
    uiConversation: { events: { register(candidate) { definition = candidate } } },
    slots: { inject() {}, register: () => () => {} },
    get: () => undefined,
    on: () => {},
    effect: () => {},
    sessions: { list: {} },
    remote: {},
  }
  exported.apply(ctx)
  return definition
}

const match = {
  event: { type: 'tool/call', seq: 2, data: { callId: 'call-1', name: 'pwsh', arguments: '{"command":"python x.py"}' } },
  role: 'update',
  location: undefined,
}
const midTurnContext = { state: undefined, start: undefined, matches: [match] }

const describe = (label, code) => {
  const definition = definitionOf(code)
  const results = {}
  try {
    definition.update(midTurnContext, match)
    results.update = 'ok'
  } catch (error) {
    results.update = `threw: ${error.message}`
  }
  try {
    results.buildLocationData = JSON.stringify(definition.buildLocationData(midTurnContext, 'turn', null))
  } catch (error) {
    results.buildLocationData = `threw: ${error.message}`
  }
  console.log(`${label}\n  update: ${results.update}\n  buildLocationData: ${results.buildLocationData}`)
  return results
}

console.log('--- as shipped (guard present)')
const fixed = describe('shipped', source)

const stripped = source.replace(GUARD, '/* guard removed for this probe */')
if (stripped === source) {
  console.log('\n(guard line not found — the probe cannot demonstrate the old failure)')
  process.exitCode = 1
} else {
  console.log('\n--- with the guard stripped (the original defect)')
  const broken = describe('guard stripped', stripped)
  const catches = broken.update.startsWith('threw') || broken.buildLocationData.startsWith('threw')
  console.log(
    catches
      ? '\nPASS: the stripped build throws, so harness.mjs check would fail on the old code.'
      : '\nFAIL: the stripped build did not throw — the regression check is not actually sensitive.',
  )
  process.exitCode = catches && fixed.update === 'ok' ? 0 : 1
}
