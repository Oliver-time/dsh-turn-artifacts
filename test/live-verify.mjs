/**
 * Checks, in a real page, that the file menu verifies before it claims.
 *
 * Two cases, because they are the two the reader experiences as "it said it
 * worked" versus "it told me why":
 *
 *   1. a tab for a file that exists   -> the opener runs (Explorer window appears)
 *   2. a tab for a file that is gone  -> nothing is opened, and the status line
 *      names the path that was tried
 *
 * The second is the one that used to be indistinguishable from success: the Host
 * swallows Explorer's exit code 1, so a missing path still reports `opened: true`.
 *
 * Run with: node test/live-verify.mjs "<url with token>" "<session title>" [out.png]
 *
 * @module test/live-verify
 */

import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, sessionTitle, outPath] = process.argv.slice(2)

const INSTRUMENT = `
window.__probe = { errors: [] };
window.addEventListener('error', (e) => window.__probe.errors.push('error: ' + String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
window.__clickText = (text) => {
  const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a, li, span, div')];
  const hits = all.filter((el) => (el.textContent || '').trim().startsWith(text));
  if (hits.length === 0) return 'no element matches ' + text;
  hits.sort((a, b) => (a.tagName === 'BUTTON' ? 0 : 1) - (b.tagName === 'BUTTON' ? 0 : 1) || a.textContent.length - b.textContent.length);
  const target = hits[0];
  const clickable = target.closest('button, [role="button"], a, li') || target;
  clickable.click();
  return 'clicked ' + clickable.tagName + ' ' + clickable.textContent.trim().slice(0, 50);
};
window.__tabRect = (basename) => {
  const bar = document.querySelector('[data-rightbar-col]');
  if (bar === null) return null;
  const candidates = [...bar.querySelectorAll('*')]
    .filter((el) => (el.textContent || '').trim().startsWith(basename) && el.children.length <= 3);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  const tab = candidates[0];
  tab.scrollIntoView({ block: 'nearest' });
  const rect = tab.getBoundingClientRect();
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
};
window.__status = () => {
  const node = document.querySelector('[data-file-tab-status]');
  return node === null ? null : node.textContent;
};
`

const powershell = (script) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }, (error, stdout) => resolve(stdout ?? ''))
})
const windows = async () => (await powershell('(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { $_.LocationURL }'))
  .split(/\r?\n/)
  .filter((line) => line !== '')

const chrome = launchChrome()
try {
  const cdp = await connect(await waitForEndpoint())
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sessionKey } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionKey)
  await cdp.send('Page.enable', {}, sessionKey)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sessionKey)

  const consoleLog = []
  const pump = setInterval(() => {
    for (const event of cdp.events.splice(0)) {
      if (event.method === 'Runtime.consoleAPICalled') {
        consoleLog.push(`${event.params.type}: ${(event.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`.slice(0, 300))
      }
      if (event.method === 'Runtime.exceptionThrown') {
        consoleLog.push(`EXCEPTION: ${(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text).slice(0, 300)}`)
      }
    }
  }, 100)

  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionKey)
    if (reply.exceptionDetails !== undefined) return { __threw: String(reply.exceptionDetails.text) }
    return reply.result?.value
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  await cdp.send('Page.navigate', { url }, sessionKey)
  await wait(14000)
  if (sessionTitle !== undefined) await evaluate(`window.__clickText(${JSON.stringify(sessionTitle)})`)
  await wait(9000)

  /** Open one chip as a tab, right-click it, and click the reveal item. */
  const exercise = async (label, chipText) => {
    console.log(`\n=== ${label}: ${chipText}`)
    const clicked = await evaluate(`(() => {
      const chip = [...document.querySelectorAll('[data-turn-artifacts-row] .dta-file')].find((el) => el.textContent.trim() === ${JSON.stringify(chipText)});
      if (chip === undefined) return 'chip gone';
      chip.scrollIntoView({ block: 'center' });
      chip.click();
      return 'clicked chip';
    })()`)
    console.log(`  ${clicked}`)
    await wait(4000)

    const preview = await evaluate(`(() => {
      const bar = document.querySelector('[data-rightbar-col]');
      return bar === null ? null : bar.innerText.split('\\n').slice(0, 3);
    })()`)
    console.log(`  sidebar: ${JSON.stringify(preview)}`)

    const rect = await evaluate(`window.__tabRect(${JSON.stringify(chipText)})`)
    if (rect === null || rect === undefined || typeof rect.x !== 'number') {
      console.log('  no tab to right-click')
      return
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 }, sessionKey)
    }
    await wait(1200)
    const menu = await evaluate(`[...document.querySelectorAll('[data-file-tab-action]')].map((el) => el.textContent.trim())`)
    console.log(`  menu: ${JSON.stringify(menu)}`)

    const before = await windows()
    await evaluate(`window.__clickText('打开文件所在路径')`)
    await wait(800)
    console.log(`  status: ${JSON.stringify(await evaluate(`window.__status()`))}`)
    await wait(3000)
    const after = await windows()
    const fresh = after.filter((entry) => !before.includes(entry))
    console.log(`  explorer windows: ${String(before.length)} -> ${String(after.length)}, new: ${fresh.length === 0 ? 'none' : fresh.join(', ')}`)
    if (fresh.length > 0) {
      const list = fresh.map((value) => `'${value.replace(/'/g, "''")}'`).join(',')
      await powershell(`foreach ($w in (New-Object -ComObject Shell.Application).Windows()) { if (@(${list}) -contains $w.LocationURL) { $w.Quit() } }`)
      console.log('  closed the window this probe opened')
    }
    await evaluate(`document.querySelector('[data-file-tab-status]')?.closest('button')?.click()`)
  }

  const chips = await evaluate(`[...document.querySelectorAll('[data-turn-artifacts-row] .dta-file')].map((el) => el.textContent.trim())`)
  console.log(`chips: ${JSON.stringify((chips ?? []).slice(0, 10))}`)
  // Page back until an artifact row is on screen; the rows live in the turns that
  // produced files, which is rarely the newest page.
  let found = chips ?? []
  for (let i = 0; i < 10 && found.length === 0; i += 1) {
    await evaluate(`window.__clickText('加载更早')`)
    await wait(2200)
    found = (await evaluate(`[...document.querySelectorAll('[data-turn-artifacts-row] .dta-file')].map((el) => el.textContent.trim())`)) ?? []
  }
  console.log(`chips after paging: ${JSON.stringify(found.slice(0, 10))}`)
  // `no-such-file.pptx` is left over from this repo's own opener probe: a name that
  // is guaranteed to resolve to nothing, which is exactly the case that used to
  // report success. Any absolute-path chip exercises the found branch.
  const missing = found.find((text) => text.startsWith('no-such-file')) ?? found.find((text) => text.endsWith('.pptx'))
  const existing = found.find((text) => text.endsWith('.js') || text.endsWith('.md'))
  if (missing !== undefined) await exercise('file that is gone', missing)
  if (existing !== undefined) await exercise('file that may exist', existing)

  console.log(`\npage errors: ${JSON.stringify(await evaluate(`window.__probe.errors.slice(0, 5)`))}`)
  console.log('--- console ---')
  for (const line of consoleLog.slice(-12)) console.log(line)
  clearInterval(pump)
  if (outPath !== undefined) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionKey)
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot -> ${outPath}`)
  }

  await cdp.send('Target.closeTarget', { targetId })
  cdp.close()
} catch (error) {
  console.error('driver failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  chrome.stop()
}
