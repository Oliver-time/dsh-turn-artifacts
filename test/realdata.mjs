/**
 * Runs the plugin's path extractor over real `tool/result` text taken from this
 * machine's session logs, so false positives show up on real tool output instead
 * of on hand-written samples.
 *
 * Run with: node test\realdata.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decompressSession } from './zstd.mjs'
import { resultTexts } from './wire.mjs'
import { sessionsRoot } from './dsh-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
let registration
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
new Function(source)()
const exported = registration.factory((spec) => {
  if (spec === 'react') return { createElement: () => ({}), useEffect() {} }
  throw new Error(`unexpected require(${spec})`)
})

const root = sessionsRoot
const results = []
for (const project of readdirSync(root)) {
  const projectDir = join(root, project)
  if (!statSync(projectDir).isDirectory()) continue
  for (const session of readdirSync(projectDir)) {
    const file = join(projectDir, session, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    let text
    try {
      text = decompressSession(file).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('tool/result')) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const event = record?.event ?? record
      if (event?.type !== 'tool/result') continue
      const content = event.data?.message?.content
      for (const text of resultTexts(content)) results.push(text)
    }
  }
}

console.log(`scanned ${String(results.length)} real tool-result blocks`)

const counts = new Map()
for (const text of results) {
  for (const path of exported.collectPaths(text)) {
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
}

const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log(`\n${String(entries.length)} distinct paths extracted, most frequent first:\n`)
for (const [path, count] of entries.slice(0, 60)) console.log(String(count).padStart(5), path)
