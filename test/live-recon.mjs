/**
 * Reconnaissance run against a live dsh web page.
 *
 * Answers the questions the offline harness cannot: what the page holds after a
 * boot, how many long tasks the history fill costs, and what the DOM offers for a
 * file mention. Prints a JSON snapshot; nothing here asserts.
 *
 * Run with: node test/live-recon.mjs "<url with token>" [out.png]
 *
 * @module test/live-recon
 */

import { writeFileSync } from 'node:fs'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, outPath] = process.argv.slice(2)
if (url === undefined) {
  console.error('usage: node test/live-recon.mjs "<url with token>" [out.png]')
  process.exit(2)
}

/** Injected before any page script: error capture plus a long-task ledger. */
const INSTRUMENT = `
window.__probe = { errors: [], longTasks: [], marks: [] };
window.addEventListener('error', (e) => window.__probe.errors.push('error: ' + String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__probe.longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
  }).observe({ entryTypes: ['longtask'] });
} catch (error) { window.__probe.errors.push('longtask observer: ' + String(error)); }
`

const chrome = launchChrome()
try {
  const cdp = await connect(await waitForEndpoint())
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sessionKey } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionKey)
  await cdp.send('Page.enable', {}, sessionKey)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sessionKey)

  const console_ = []
  const pump = setInterval(() => {
    for (const event of cdp.events.splice(0)) {
      if (event.method === 'Runtime.consoleAPICalled') {
        const text = (event.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
        console_.push(`${event.params.type}: ${text}`.slice(0, 240))
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails
        console_.push(`EXCEPTION: ${d.text} :: ${(d.exception?.description ?? '').slice(0, 240)}`)
      }
    }
  }, 100)

  const started = Date.now()
  await cdp.send('Page.navigate', { url }, sessionKey)

  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionKey)
    if (reply.exceptionDetails !== undefined) return { __threw: String(reply.exceptionDetails.text) }
    return reply.result?.value
  }

  // Give the app time to boot and (if storage remembers one) open a session.
  await new Promise((resolve) => setTimeout(resolve, 15000))

  const snapshot = await evaluate(`(() => {
    const probe = window.__probe;
    const sessions = [...document.querySelectorAll('[data-session-id], [data-session], li, button')]
      .filter((el) => el.getAttribute && (el.getAttribute('data-session-id') || el.getAttribute('data-session')));
    const buttons = [...document.querySelectorAll('code button')];
    const globals = Object.keys(window).filter((k) => /dsh|DSH|ModuleLoader|cordis/i.test(k));
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      domNodes: document.getElementsByTagName('*').length,
      textLength: document.body.innerText.length,
      sessionNodes: sessions.length,
      sessionIds: sessions.slice(0, 8).map((el) => el.getAttribute('data-session-id') || el.getAttribute('data-session')),
      codeButtons: buttons.length,
      codeButtonSample: buttons.slice(0, 6).map((el) => el.textContent.slice(0, 60)),
      globals,
      longTasks: probe.longTasks.length,
      longTaskTotalMs: probe.longTasks.reduce((sum, t) => sum + t.dur, 0),
      longTaskWorst: probe.longTasks.slice().sort((a, b) => b.dur - a.dur).slice(0, 5),
      errors: probe.errors.slice(0, 10),
      elapsedMs: ${String(Date.now() - started)},
    };
  })()`)

  console.log(JSON.stringify(snapshot, null, 1))
  console.log('--- console (last 25) ---')
  for (const line of console_.slice(-25)) console.log(line)

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
