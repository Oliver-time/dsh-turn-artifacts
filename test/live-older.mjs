/**
 * Inspects the transcript's "load older" control in a live page.
 *
 * Run with: node test/live-older.mjs "<url with token>" "<session title>"
 *
 * @module test/live-older
 */

import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, sessionTitle] = process.argv.slice(2)
const INSTRUMENT = `
window.__probeClick = (text) => {
  const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a, li, span, div')];
  const hits = all.filter((el) => (el.textContent || '').trim().startsWith(text));
  if (hits.length === 0) return 'no element matches';
  hits.sort((a, b) => a.textContent.length - b.textContent.length);
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

  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionKey)
    if (reply.exceptionDetails !== undefined) return { __threw: String(reply.exceptionDetails.text) }
    return reply.result?.value
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  await cdp.send('Page.navigate', { url }, sessionKey)
  await wait(14000)
  if (sessionTitle !== undefined) {
    console.log(await evaluate(`window.__probeClick(${JSON.stringify(sessionTitle)})`))
    await wait(12000)
  }

  console.log('--- the older control ---')
  console.log(JSON.stringify(await evaluate(`(() => {
    const hits = [...document.querySelectorAll('*')].filter((el) => (el.textContent || '').trim() === '加载更早');
    return hits.map((el) => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 80),
      role: el.getAttribute('role'),
      pointer: getComputedStyle(el).pointerEvents,
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      html: el.outerHTML.slice(0, 400),
      parent: el.parentElement === null ? null : el.parentElement.outerHTML.slice(0, 300),
    }));
  })()`), null, 1))

  const before = await evaluate(`document.getElementsByTagName('*').length`)
  const rect = await evaluate(`(() => {
    const el = [...document.querySelectorAll('*')].find((n) => (n.textContent || '').trim() === '加载更早');
    if (el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`)
  console.log('target point:', JSON.stringify(rect))
  if (rect !== null) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionKey)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionKey)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionKey)
  }
  await wait(3000)
  const after = await evaluate(`document.getElementsByTagName('*').length`)
  console.log(`nodes ${String(before)} -> ${String(after)}`)

  await cdp.send('Target.closeTarget', { targetId })
  cdp.close()
} catch (error) {
  console.error('driver failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  chrome.stop()
}
