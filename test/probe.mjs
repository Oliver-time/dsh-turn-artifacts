/**
 * Eyeball probe for the artifact path extractor.
 *
 * Prints what `collectPaths` makes of a handful of realistic tool-output strings,
 * and then what it makes of a real settled-result block built in the wire shape
 * (`test/wire.mjs`). This is the file that shows, in one screen, why a path with
 * a Chinese directory or a drive letter survives and why a URL or a bare file
 * name does not — the extractor's rules are easier to trust by example than by
 * reading its character classes.
 *
 * Nothing here asserts; `test/harness.mjs` owns the pass/fail checks.
 *
 * Run with: node test\probe.mjs
 *
 * @module test/probe
 */

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

const pptx = 'C:\\Users\\LIU\\Desktop\\lyh_robot\\_文档\\暑期汇报_20260909\\暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx'
const samples = [
  JSON.stringify({ written: pptx, chart: '_文档\\暑期汇报_20260909\\assets\\_v13_overview.png' }),
  'chart -> assets/trend_v2.png (ok)',
  'python assets/polish_v13.py',
  'see _v13_overview.png and 暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx',
  'interpreter C:\\Users\\LIU\\.local\\bin\\python3.12.exe',
  'url https://example.com/x.svg and data:image/png;base64,AAAA',
  'quoted "C:\\Users\\LIU\\out\\报告.pdf", comma',
  'nested (sub/dir/deep/file.mp4) end',
  './relative/file.md and ../up/file.md',
  'version 13.2 released; a.b.c.d is not a path',
]

for (const sample of samples) {
  console.log('---', sample)
  console.log('   ', exported.collectPaths(sample))
}

/**
 * The real wire shape: the readable payload sits one level below the block, so
 * the plugin has to flatten `block.content[].text` before it can see any path.
 * A fixture that puts the text on the block itself hides that bug.
 */
const wireBlock = {
  type: 'tool-result',
  toolCallId: 'call-1',
  isError: false,
  content: [{ type: 'text', text: JSON.stringify({ written: pptx }) }],
}
console.log('--- nested wire block (block.content[].text)')
console.log('   ', exported.collectPaths(exported.resultText([wireBlock])))

