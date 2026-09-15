/**
 * Exercises the Host's native reveal/open calls directly, outside the GUI.
 *
 * The right-click item "打开文件所在路径" runs the same Host code the sidebar uses:
 * `session.openWorkspacePath({ path, action: 'reveal' })` reaches
 * `revealNativePath`, which on Windows spawns `explorer.exe /select, <file URL>`.
 * This script calls it with no browser, no GUI and no plugin in the way, so a
 * failure here is the Host's, and a success here is the plugin's.
 *
 * Run with: node test/reveal-probe.mjs "<absolute path>" [open|reveal]
 *
 * @module test/reveal-probe
 */

const [, , target, intent = 'reveal'] = process.argv
if (target === undefined) {
  console.error('usage: node test/reveal-probe.mjs "<absolute path>" [open|reveal]')
  process.exit(2)
}

const nativeCommand = await import(
  'file:///C:/Users/LIU/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-native-command/lib/index.js'
)

console.log(`platform=${process.platform} intent=${intent}`)
console.log(`target=${target}`)

const { pathToFileURL } = await import('node:url')
const url = pathToFileURL(target, { windows: true }).href
console.log(`as file URL (what reveal builds): ${url.replaceAll(',', '%2C')}`)
console.log(`fileManager=${String(nativeCommand.nativeFileManager())} canOpen=${String(nativeCommand.canOpenNativePath())}`)

const controller = new AbortController()
const started = Date.now()
try {
  if (intent === 'reveal') await nativeCommand.revealNativePath(target, controller.signal)
  else await nativeCommand.openNativePath(target, controller.signal)
  console.log(`resolved in ${String(Date.now() - started)} ms`)
} catch (error) {
  console.log(`rejected in ${String(Date.now() - started)} ms`)
  console.log(`  name=${error?.name} code=${String(error?.code)} message=${error?.message}`)
  if (error?.cause !== undefined) console.log(`  cause=${String(error.cause?.message ?? error.cause)}`)
  process.exitCode = 1
}
