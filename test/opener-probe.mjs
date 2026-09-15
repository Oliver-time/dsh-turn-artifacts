/**
 * What the Host's *default* opener does with a path that is not there.
 *
 * This is the other half of the silent-success story: `revealNativePath` tolerates
 * Explorer's exit code 1 (which Explorer returns for a path it cannot select), and
 * the folder fallback runs `Invoke-Item`. If either reports success for a path that
 * does not exist, the plugin's status line is lying to the reader.
 *
 * Run with: node test/opener-probe.mjs "<absolute path that does not exist>"
 *
 * @module test/opener-probe
 */

import { execFile } from 'node:child_process'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node test/opener-probe.mjs "<absolute path>"')
  process.exit(2)
}

const nativeCommand = await import(
  'file:///C:/Users/LIU/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-native-command/lib/index.js'
)

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error === null ? 0 : (error.code ?? 'threw'), stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim() })
  })
})

console.log(`target: ${target}`)

const open = await run('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item -LiteralPath ${`'${target.replace(/'/g, "''")}'`}`])
console.log(`Invoke-Item (the default/folder opener): exit=${String(open.code)}${open.stderr === '' ? '' : ` stderr=${open.stderr.slice(0, 160)}`}`)

const reveal = await run('explorer.exe', ['/select,', target])
console.log(`explorer /select, with a native path: exit=${String(reveal.code)}`)

const controller = new AbortController()
const started = Date.now()
try {
  await nativeCommand.openNativePath(target, controller.signal)
  console.log(`openNativePath: resolved in ${String(Date.now() - started)} ms <= reports SUCCESS`)
} catch (error) {
  console.log(`openNativePath: rejected in ${String(Date.now() - started)} ms: ${error?.message}`)
}
