/**
 * Checks for the Host half: the prompt guidance it registers, and the service it
 * publishes.
 *
 * There is no `dsh` runtime here either, so the harness supplies a fake context
 * with the two services this half touches and records what `apply()` registers.
 * The load-bearing assertion is the section *name*: the guidance must sit beside
 * the shipped `ui:deliverable-file-references` section rather than reuse its
 * name, because a Loader row registers in the global prompt layer, where a
 * duplicate name is a hard error that aborts the whole profile boot.
 *
 * Run with: `node test/host.mjs`, or `npm test` for this plus the client bundle.
 *
 * @module test/host
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// The same rule the Loader row follows: a bare Windows path is not a valid ESM
// specifier, so the module is imported through its file URL.
const module = await import(pathToFileURL(join(here, '..', 'index.js')).href)

/** The shipped sentence this half must keep, taken from the installed package. */
const SHIPPED_PREFIX = 'When you successfully create or modify files, mention the primary outputs in your final response.'

/** Captures what apply() registers. */
function fakeContext() {
  const ctx = { sections: [], services: new Map() }
  ctx.systemPrompt = {
    getSectionOrder: (name) => {
      assert.equal(name, 'DELIVERABLE_FILE_REFERENCES', 'the order must come from the central table, not a literal')
      return 9000
    },
    section: (section) => {
      ctx.sections.push(section)
      return () => {}
    },
  }
  ctx.provide = (name, service) => ctx.services.set(name, service)
  return ctx
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the host half needs the system prompt service', () => {
  assert.deepEqual(module.inject, ['systemPrompt'])
})

check('guidance sits right after the shipped section, under its own name', () => {
  const ctx = fakeContext()
  module.apply(ctx)
  assert.equal(ctx.sections.length, 1, 'exactly one prompt section')
  const [section] = ctx.sections
  assert.equal(section.name, 'ui:turn-artifact-file-references', 'a distinct name, because a global duplicate name is a boot error')
  assert.equal(section.order, 9001, 'one step after the shipped guidance so both paragraphs read in order')
  assert.ok(!section.text.startsWith(SHIPPED_PREFIX), 'this paragraph adds to the shipped one instead of repeating it')
  assert.ok(!/When you successfully create or modify files/.test(section.text), 'the shipped sentence is not duplicated')
})

check('guidance covers script-produced files and how to make them linkable', () => {
  const ctx = fakeContext()
  module.apply(ctx)
  const text = ctx.sections[0].text
  assert.match(text, /Markdown inline code/, 'the format rule is stated')
  assert.match(text, /produced by a terminal command/, 'script output is named as a case')
  assert.match(text, /only become a link if the path appeared/, 'the evidence requirement is stated')
  assert.ok(text.length < 700, 'one paragraph, not an essay')
})

check('status service reports the mounted half', () => {
  const ctx = fakeContext()
  module.apply(ctx)
  const status = ctx.services.get('turn-artifacts')
  // Compared against the constant rather than a literal, so a version bump
  // cannot leave a stale expectation behind.
  assert.deepEqual(status.status(), { name: 'dsh-turn-artifacts', version: module.PLUGIN_VERSION })
})

check('package version matches the published constant', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.version, module.PLUGIN_VERSION)
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${String(checks.length - failed)}/${String(checks.length)} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
