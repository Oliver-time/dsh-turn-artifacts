/**
 * Exercises one artifact chip in a live page: it must exist (which already proves
 * the loopback check reached the Host) and clicking it must open the Sidebar.
 *
 * Run with: node test/live-chip.mjs "<url with token>" "<session title>" [out.png]
 *
 * @module test/live-chip
 */

import { writeFileSync } from 'node:fs'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, sessionTitle, outPath] = process.argv.slice(2)
const INSTRUMENT = `
window.__probe = { errors: [] };
window.addEventListener('error', (e) => window.__probe.errors.push('error: ' + String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
window.__probeClick = (text) => {
  const all = [...document.querySelectorAll('button, [role="button"], a, li, span, div')];
  const hits = all.filter((el) => (el.textContent || '').trim().startsWith(text));
  if (hits.length === 0) return 'no element matches';
  hits.sort((a, b) => (a.tagName === 'BUTTON' ? 0 : 1) - (b.tagName === 'BUTTON' ? 0 : 1) || a.textContent.length - b.textContent.length);
  const target = hits[0];
  const clickable = target.closest('button, [role="button"], a, li') || target;
  clickable.click();
  return 'clicked: ' + clickable.tagName + '.' + String(clickable.className).slice(0, 60);
};
`

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
  if (sessionTitle !== undefined) await evaluate(`window.__probeClick(${JSON.stringify(sessionTitle)})`)

  // Page back until a chip row is on screen, the same way a reader would.
  let rows = 0
  for (let i = 0; i < 12 && rows === 0; i += 1) {
    await wait(2000)
    rows = await evaluate(`document.querySelectorAll('[data-turn-artifacts-row]').length`)
    if (rows === 0) await evaluate(`window.__probeClick('加载更早')`)
  }
  const chips = await evaluate(`[...document.querySelectorAll('[data-turn-artifacts-row] .dta-file')].map((el) => el.textContent.slice(0, 60))`)
  console.log('chip rows:', rows, 'chips:', JSON.stringify((chips ?? []).slice(0, 8)))

  const before = await evaluate(`(document.querySelector('[data-rightbar-col]') || {}).innerText ?? null`)
  const clicked = await evaluate(`(() => {
    const chip = document.querySelector('[data-turn-artifacts-row] .dta-file');
    if (chip === null) return 'no chip';
    chip.scrollIntoView({ block: 'center' });
    chip.click();
    return 'clicked ' + chip.textContent.slice(0, 60);
  })()`)
  await wait(4000)
  const after = await evaluate(`(() => {
    const bar = document.querySelector('[data-rightbar-col]');
    return bar === null ? null : bar.innerText.slice(0, 300);
  })()`)

  console.log('clicked chip:', clicked)
  console.log('rightbar before:', JSON.stringify(before))
  console.log('rightbar after:', JSON.stringify(after))
  console.log('errors:', JSON.stringify(await evaluate(`window.__probe.errors.slice(0, 8)`)))
  console.log('--- console ---')
  for (const line of consoleLog.slice(-12)) console.log(line)

  if (outPath !== undefined) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionKey)
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot -> ${outPath}`)
  }

  clearInterval(pump)
  await cdp.send('Target.closeTarget', { targetId })
  cdp.close()
} catch (error) {
  console.error('driver failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  chrome.stop()
}
