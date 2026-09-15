/**
 * Diagnostic: replays the newest real session logs through the plugin's
 * extractor, per turn, and prints every path it would index.
 *
 * This is the tool for "the link opened the wrong place". It separates the two
 * layers that can be at fault: what the extractor pulled out of the tool traffic
 * (this file's output) and where a mention then resolved (visible in a link's
 * `title` in the GUI). If the wrong path is absent here, the fault is in
 * resolution; if it is present, the fault is in extraction.
 *
 * Reads `$DSH_HOME/sessions` and decodes `.jsonl.zstd` logs through `zstd.mjs`.
 * Nothing here asserts; `test/harness.mjs` owns the pass/fail checks.
 *
 * Run with: node test\diagnose.mjs [needle]   (default `.pptx`)
 *
 * @module test/diagnose
 */

import { readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decompressSession } from './zstd.mjs'
import { resultTexts } from './wire.mjs'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
let registration
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
new Function(source)()
const exported = registration.factory((spec) => {
  if (spec === 'react') return { createElement: () => ({}), useEffect() {} }
  throw new Error(`unexpected require(${spec})`)
})

/** The substring a path must contain to be reported; the first argument. */
const NEEDLE = process.argv[2] ?? '.pptx'

/** Newest session logs first. */
function logs() {
  const root = 'C:\\Users\\LIU\\.dsh\\sessions'
  const found = []
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const file = join(projectDir, session, 'session.jsonl.zstd')
      if (existsSync(file)) found.push({ file, project, mtime: statSync(file).mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 6)
}

for (const { file, project } of logs()) {
  let text
  try {
    text = decompressSession(file).toString('utf8')
  } catch (error) {
    console.log(`${project}: decode failed (${error.message})`)
    continue
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const results = []
  const calls = new Map()
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const event = record.event ?? record
    if (event?.type === 'tool/call') {
      calls.set(String(event.data?.callId), { name: event.data?.name, args: String(event.data?.arguments ?? '') })
    }
    if (event?.type === 'tool/result') {
      const content = event.data?.message?.content
      const texts = resultTexts(content)
      results.push({ callId: String(event.data?.message?.source?.callId), texts })
    }
  }
  if (!text.includes(NEEDLE) && !text.includes('pptx')) continue
  console.log(`\n=== ${project}  (${String(results.length)} results, ${String(calls.size)} calls, ${String(lines.length)} lines, ${String(text.length)} chars) ===`)
  for (const { callId, texts } of results) {
    const call = calls.get(callId)
    const callPaths = call === undefined ? [] : exported.collectCallPaths(call.name, call.args)
    if (callPaths.length > 0) console.log(`  call   ${String(call?.name)} -> ${JSON.stringify(callPaths)}`)
    for (const text of texts) {
      const paths = exported.collectPaths(text)
      if (paths.length === 0) continue
      if (!paths.some((path) => path.includes(NEEDLE))) continue
      console.log(`  result -> ${JSON.stringify(paths)}`)
    }
  }
}
