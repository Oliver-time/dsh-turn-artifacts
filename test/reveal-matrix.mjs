/**
 * Measures the Host's reveal against a unique folder per case, on this machine.
 *
 * `revealNativePath` hands Explorer a percent-encoded `file:///` URL. This script
 * prints the exact argv the Host builds, then runs one variant at a time against a
 * folder nothing else has open, and asks the shell itself (Shell.Application) which
 * Explorer window exists afterwards. A unique folder is what makes the reading
 * trustworthy: Explorer reuses an existing window for a folder it already shows, so
 * counting new windows reports "nothing happened" for a call that merely focused one.
 *
 * Every window it opens is closed again.
 *
 * Run with: node test/reveal-matrix.mjs
 *
 * @module test/reveal-matrix
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { dshModuleUrl } from './dsh-paths.mjs'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = join(here, '..', '.reveal-test')

const nativeCommand = await import(dshModuleUrl('dsh-native-command', 'lib/index.js'))

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error === null ? 0 : (error.code ?? 'threw'), stdout, stderr })
  })
})

const powershell = (script) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }, (error, stdout) => {
    resolve(stdout ?? '')
  })
})

/** Explorer window URLs, straight from the shell. */
const windows = async () => (await powershell('(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { $_.LocationURL }'))
  .split(/\r?\n/)
  .filter((line) => line !== '')

/** Close every Explorer window whose URL contains one of these fragments. */
const closeWindows = async (fragments) => {
  const list = fragments.map((value) => `'${value.replace(/'/g, "''")}'`).join(',')
  await powershell(`
$hits = @(${list})
foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
  foreach ($hit in $hits) { if ($w.LocationURL -like "*$hit*") { $w.Quit(); break } }
}`)
}

/** One case: a fresh folder holding a file whose name exercises the encoder. */
const caseOf = (label, fileName) => {
  const dir = join(root, label)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  writeFileSync(file, 'probe')
  return { label, dir, file }
}

const cases = [
  caseOf('ascii', 'plain.txt'),
  caseOf('space', 'with space.txt'),
  caseOf('comma', 'comma,file.txt'),
  caseOf('cjk', '暑期科研汇报_v13.pptx'),
  caseOf('cjk-dir-中文目录', 'report.pptx'),
]

const expected = (dir) => `file:///${dir.replace(/\\/g, '/').replace(/ /g, '%20')}`

console.log('host argv, captured with a stub runner:')
const probe = cases[0]
await nativeCommand.revealNativePath(probe.file, new AbortController().signal, {
  run: async (command, args) => {
    console.log(`  ${command} ${args.map((a) => JSON.stringify(a)).join(' ')}`)
    return { stdout: '', stderr: '' }
  },
})

/** Run one variant and report whether that folder's window exists afterwards. */
const measure = async (name, dir, command, args) => {
  await closeWindows([dir.replace(/\\/g, '/'), encodeURI(dir.replace(/\\/g, '/'))])
  const result = await run(command, args)
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const open = await windows()
  const hit = open.find((url) => decodeURI(url).toLowerCase().startsWith(expected(dir).toLowerCase()))
  console.log(`  ${name}: exit=${String(result.code)} -> ${hit === undefined ? 'NO WINDOW FOR THAT FOLDER' : hit}`)
  await closeWindows([dir.replace(/\\/g, '/'), encodeURI(dir.replace(/\\/g, '/'))])
}

for (const item of cases) {
  const url = pathToFileURL(item.file, { windows: true }).href.replaceAll(',', '%2C')
  console.log(`\n=== ${item.label}: ${item.file}`)
  console.log(`  encoded URL the Host builds: ${url}`)
  await measure('A as-shipped (encoded file URL, /select,)', item.dir, 'explorer.exe', ['/select,', url])
  await measure('B native path as one /select, argument', item.dir, 'explorer.exe', [`/select,${item.file}`])
  await measure('C open the containing folder (Invoke-Item)', item.dir, 'powershell.exe', [
    '-NoProfile',
    '-Command',
    `Invoke-Item -LiteralPath '${item.dir.replace(/'/g, "''")}'`,
  ])
}

rmSync(root, { recursive: true, force: true })
console.log('\nremoved the probe folders and closed their windows')
