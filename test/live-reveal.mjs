/**
 * Drives the real gesture the user reported: right-click a Sidebar file tab and
 * choose "打开文件所在路径", then reports whether Explorer actually went somewhere.
 *
 * The browser side is CDP; the desktop side is the shell's own COM automation, so
 * "did a window for that folder appear" is measured rather than assumed. It opens
 * Explorer windows and closes the ones it opened.
 *
 * Run with: node test/live-reveal.mjs "<url with token>" "<session title>" [--pptx]
 *
 * @module test/live-reveal
 */

import { execFile } from 'node:child_process'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, sessionTitle, flag] = process.argv.slice(2)
const wantPptx = flag === '--pptx'

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
  return {
    tag: tab.tagName,
    cls: String(tab.className).slice(0, 60),
    html: tab.outerHTML.slice(0, 200),
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
};
`

/** Explorer window URLs, via the shell's COM automation. */
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

  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionKey)
    if (reply.exceptionDetails !== undefined) return { __threw: String(reply.exceptionDetails.text) }
    return reply.result?.value
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  await cdp.send('Page.navigate', { url }, sessionKey)
  await wait(14000)
  if (sessionTitle !== undefined) await evaluate(`window.__clickText(${JSON.stringify(sessionTitle)})`)

  // Page back until a mention of the wanted kind is on screen.
  let mentions = []
  for (let i = 0; i < 14; i += 1) {
    await wait(2000)
    mentions = await evaluate(`[...document.querySelectorAll('code button')].map((el) => el.textContent.trim())`)
    const ready = wantPptx ? mentions.some((text) => text.endsWith('.pptx')) : mentions.length > 0
    if (ready) break
    await evaluate(`window.__clickText('加载更早')`)
  }
  console.log(`mentions on screen: ${String(mentions.length)} -> ${JSON.stringify(mentions.slice(0, 6))}`)

  // `--pptx` prefers a chip whose name the Windows reveal cannot survive: the
  // artifact row lists what a command produced, so a Chinese-named file shows up
  // there without needing a prose mention of it.
  let wanted = wantPptx ? mentions.find((text) => text.endsWith('.pptx')) : mentions[0]
  if (wantPptx && wanted === undefined) {
    const chips = await evaluate(`[...document.querySelectorAll('[data-turn-artifacts-row] .dta-file')].map((el) => el.textContent.trim())`)
    console.log(`chips on screen: ${JSON.stringify(chips.slice(0, 8))}`)
    const cjk = chips.find((text) => /[^\u0020-\u007E]/.test(text))
    if (cjk !== undefined) {
      console.log(`clicking chip: ${cjk}`)
      await evaluate(`(() => {
        const chip = [...document.querySelectorAll('[data-turn-artifacts-row] .dta-file')].find((el) => el.textContent.trim() === ${JSON.stringify(cjk)});
        if (chip === undefined) return 'gone';
        chip.scrollIntoView({ block: 'center' });
        chip.click();
        return 'clicked';
      })()`)
      await wait(4000)
      wanted = cjk
    }
  }
  if (wanted === undefined) {
    console.log('no mention of the wanted kind; nothing to open')
  } else {
    console.log(`clicking mention: ${wanted}`)
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('code button')].find((el) => el.textContent.trim() === ${JSON.stringify(wanted)});
      if (button === undefined) return 'gone';
      button.click();
      return 'clicked';
    })()`)
    await wait(4000)

    const tabText = await evaluate(`(() => {
      const bar = document.querySelector('[data-rightbar-col]');
      return bar === null ? null : bar.innerText.split('\\n').slice(0, 4);
    })()`)
    console.log(`sidebar tab text: ${JSON.stringify(tabText)}`)

    const before = await windows()
    console.log(`explorer windows before: ${String(before.length)}`)

    const rect = await evaluate(`window.__tabRect(${JSON.stringify(wanted)})`)
    console.log(`tab element: ${JSON.stringify(rect)}`)
    if (rect !== null && rect !== undefined && typeof rect.x === 'number') {
      // A real right-click, not a synthetic event: the menu is positioned from the
      // pointer and may open on mousedown rather than on `contextmenu`.
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: rect.x,
          y: rect.y,
          button: 'right',
          buttons: type === 'mousePressed' ? 2 : 0,
          clickCount: 1,
        }, sessionKey)
      }
    }
    await wait(1500)
    const menu = await evaluate(`[...document.querySelectorAll('[role="menuitem"], [data-file-tab-action]')].map((el) => el.textContent.trim())`)
    console.log(`menu items: ${JSON.stringify(menu)}`)

    console.log(await evaluate(`window.__clickText('打开文件所在路径')`))
    // The menu reports the outcome and closes shortly after, so the line has to be
    // read inside that window rather than once everything has settled.
    await wait(700)
    const status = await evaluate(`(() => {
      const node = document.querySelector('[data-file-tab-status]');
      return node === null ? null : node.textContent;
    })()`)
    console.log(`plugin status line: ${JSON.stringify(status)}`)
    await wait(3500)

    const goneOrNot = await evaluate(`document.querySelector('[data-file-tab-status]') === null ? 'menu closed' : 'menu still open'`)
    console.log(`after the linger: ${goneOrNot}`)
    const after = await windows()
    const fresh = after.filter((entry) => !before.includes(entry))
    console.log(`explorer windows after: ${String(after.length)}, new: ${fresh.length === 0 ? 'none' : fresh.join(', ')}`)
    console.log(`page errors: ${JSON.stringify(await evaluate(`window.__probe.errors.slice(0, 5)`))}`)

    if (fresh.length > 0) {
      const list = fresh.map((value) => `'${value.replace(/'/g, "''")}'`).join(',')
      await powershell(`foreach ($w in (New-Object -ComObject Shell.Application).Windows()) { if (@(${list}) -contains $w.LocationURL) { $w.Quit() } }`)
      console.log('closed the window this probe opened')
    }
  }

  await cdp.send('Target.closeTarget', { targetId })
  cdp.close()
} catch (error) {
  console.error('driver failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  chrome.stop()
}
