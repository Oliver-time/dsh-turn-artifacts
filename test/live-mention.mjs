/**
 * Drives one real dsh web page: opens a session, measures the history fill's
 * cost, and clicks a file mention to see whether a Sidebar tab appears.
 *
 * Everything it reports is measured in the page, not inferred: long tasks from a
 * PerformanceObserver, mention buttons from the DOM, and the Sidebar's own text
 * before and after the click.
 *
 * Run with: node test/live-mention.mjs "<url with token>" "<session title>" [out.png]
 *
 * @module test/live-mention
 */

import { writeFileSync } from 'node:fs'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, sessionTitle, outPath] = process.argv.slice(2)
if (url === undefined) {
  console.error('usage: node test/live-mention.mjs "<url with token>" "<session title>" [out.png]')
  process.exit(2)
}

/** Injected before any page script: error capture, long tasks, and click helpers. */
const INSTRUMENT = `
window.__probe = { errors: [], longTasks: [], notes: [] };
window.addEventListener('error', (e) => window.__probe.errors.push('error: ' + String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__probe.longTasks.push({ t: Math.round(entry.startTime), d: Math.round(entry.duration) });
  }).observe({ entryTypes: ['longtask'] });
} catch (error) { window.__probe.errors.push('longtask observer: ' + String(error)); }

/** Clear the long-task ledger so a window measures only what follows. */
window.__probeReset = () => { window.__probe.longTasks.length = 0; window.__probe.errors.length = 0; };

/** The scrollable right Sidebar column, whatever the current class spelling is. */
window.__rightbar = () => document.querySelector('[data-rightbar-col]') || null;

/** Click the smallest element whose text starts with \`text\`, preferring a button. */
window.__probeClick = (text) => {
  const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a, li, span, div')];
  const hits = all.filter((el) => (el.textContent || '').trim().startsWith(text));
  if (hits.length === 0) return 'no element matches';
  // A wrapper div and the button inside it carry the same text, and the handler is
  // on the button: clicking the wrapper does nothing at all.
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
        const text = (event.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
        consoleLog.push(`${event.params.type}: ${text}`.slice(0, 400))
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails
        consoleLog.push(`EXCEPTION: ${d.text} :: ${(d.exception?.description ?? '').slice(0, 400)}`)
      }
    }
  }, 100)

  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionKey)
    if (reply.exceptionDetails !== undefined) return { __threw: String(reply.exceptionDetails.text) }
    return reply.result?.value
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const report = {}

  await cdp.send('Page.navigate', { url }, sessionKey)
  await wait(14000)
  report.boot = await evaluate(`({ nodes: document.getElementsByTagName('*').length, rightbar: window.__rightbar() !== null })`)

  if (sessionTitle !== undefined) {
    await evaluate(`window.__probeReset()`)
    report.clickedSession = await evaluate(`window.__probeClick(${JSON.stringify(sessionTitle)})`)
    await wait(1500)
    // Sample while the history fill runs, so its cost is attributed to it.
    report.duringFill = []
    for (let i = 0; i < 12; i += 1) {
      await wait(2500)
      report.duringFill.push(await evaluate(`(() => {
        const p = window.__probe;
        const rows = p.longTasks.length;
        const total = p.longTasks.reduce((s, t) => s + t.d, 0);
        p.longTasks.length = 0;
        return {
          nodes: document.getElementsByTagName('*').length,
          mentions: document.querySelectorAll('code button').length,
          longTasks: rows,
          longTaskMs: total,
          worst: Math.max(0, ...p.longTasks.map((t) => t.d)),
        };
      })()`))
    }
  }

  report.mentions = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('code button')];
    return {
      count: buttons.length,
      sample: buttons.slice(0, 10).map((el) => el.textContent.slice(0, 80)),
      html: buttons.length === 0 ? null : buttons[0].outerHTML.slice(0, 300),
    };
  })()`)

  // Reader flow when the auto-fill stopped short: page back until the turns that
  // mention files are on screen. Entering history this way must index it, so a
  // mention appearing here is also the check that paging feeds the vocabulary.
  report.paging = []
  for (let i = 0; i < 14 && report.mentions.count === 0; i += 1) {
    const clicked = await evaluate(`window.__probeClick('加载更早')`)
    await wait(1800)
    report.paging.push({ clicked, mentions: await evaluate(`document.querySelectorAll('code button').length`), nodes: await evaluate(`document.getElementsByTagName('*').length`) })
    report.mentions = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('code button')];
      return { count: buttons.length, sample: buttons.slice(0, 10).map((el) => el.textContent.slice(0, 80)), html: buttons.length === 0 ? null : buttons[0].outerHTML.slice(0, 300) };
    })()`)
  }

  report.beforeClick = await evaluate(`(() => {
    const bar = window.__rightbar();
    return { rightbar: bar !== null, text: bar === null ? null : bar.innerText.slice(0, 500) };
  })()`)

  report.clickedMention = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('code button')];
    const first = buttons.find((el) => el.textContent.trim().length > 3) || buttons[0];
    if (first === undefined) return 'no mention button';
    first.scrollIntoView({ block: 'center' });
    first.click();
    return 'clicked: ' + first.textContent.slice(0, 60);
  })()`)
  await wait(4000)

  report.afterClick = await evaluate(`(() => {
    const bar = window.__rightbar();
    return {
      rightbar: bar !== null,
      text: bar === null ? null : bar.innerText.slice(0, 800),
      tabTitles: bar === null ? [] : [...bar.querySelectorAll('button')].map((el) => el.textContent.slice(0, 40)).slice(0, 12),
    };
  })()`)

  report.probeErrors = await evaluate(`window.__probe.errors.slice(0, 12)`)

  console.log(JSON.stringify(report, null, 1))
  console.log('--- console (last 30) ---')
  for (const line of consoleLog.slice(-30)) console.log(line)

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
