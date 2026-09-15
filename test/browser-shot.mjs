/**
 * Screenshots a named session in a real Chrome and dumps the DOM facts needed to
 * tell "the plugin did not load" from "the plugin loaded but rendered nothing":
 * script tags actually fetched, inline-code elements present, and whether the
 * plugin's bundle is in the boot graph.
 *
 * Run with: node test/browser-shot.mjs "<url with token>" "<title fragment>" <out.png>
 *
 * @module test/browser-shot
 */

import { writeFileSync } from 'node:fs'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const [url, fragment, outPath] = process.argv.slice(2)
if (url === undefined || outPath === undefined) {
  console.error('usage: node test/browser-shot.mjs "<url>" "<title fragment>" <out.png>')
  process.exit(2)
}

const chrome = launchChrome()
try {
  const cdp = await connect(await waitForEndpoint())
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sessionKey } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  const logs = []
  const failures = []
  await cdp.send('Runtime.enable', {}, sessionKey)
  await cdp.send('Page.enable', {}, sessionKey)
  await cdp.send('Network.enable', {}, sessionKey)
  const pluginRequests = []
  const pump = setInterval(() => {
    for (const event of cdp.events.splice(0)) {
      if (event.method === 'Runtime.consoleAPICalled') {
        const text = (event.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        logs.push(`${event.params.type}: ${text}`.slice(0, 300))
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails
        failures.push(`${d.text} :: ${d.exception?.description ?? ''}`.slice(0, 400))
      }
      if (event.method === 'Network.requestWillBeSent' && String(event.params.request?.url ?? '').includes('/plugins/')) {
        pluginRequests.push(event.params.request.url.slice(0, 120))
      }
    }
  }, 100)

  const evaluate = async (expression) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionKey)
    return reply.result?.value
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  await cdp.send('Page.navigate', { url }, sessionKey)
  await wait(10000)

  if (fragment !== undefined && fragment !== '-') {
    await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('button, a, div, li, span')];
      const hit = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(fragment)});
      if (hit) (hit.closest('button, a, li, [role="button"]') || hit).click();
      return hit !== undefined;
    })()`)
    await wait(9000)
  }

  const facts = await evaluate(`(() => {
    const codes = [...document.querySelectorAll('code')].map((c) => c.textContent);
    const buttons = [...document.querySelectorAll('button')].map((b) => ({ cls: String(b.className || ''), text: (b.textContent || '').slice(0, 60), title: (b.title || '').slice(0, 80) }));
    return {
      pluginInBootGraph: document.documentElement.innerHTML.includes('dsh-turn-artifacts'),
      inlineCodeCount: codes.length,
      inlineCodeSample: codes.slice(-12),
      fileMentionButtons: buttons.filter((b) => b.cls.includes('fileMention')).length,
      artifactRows: document.querySelectorAll('[data-turn-artifacts-row]').length,
      allButtonsSample: buttons.slice(-14),
      pptxInText: (document.body.innerText || '').includes('.pptx'),
    };
  })()`)
  console.log(JSON.stringify(facts, null, 1))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionKey)
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  console.log(`\nscreenshot -> ${outPath}`)
  console.log(`\nplugin bundle requests: ${String(pluginRequests.length)}`)
  console.log(`console: ${String(logs.length)} | uncaught: ${String(failures.length)}`)
  for (const line of failures.slice(0, 8)) console.log(line)

  clearInterval(pump)
  await cdp.send('Target.closeTarget', { targetId })
  cdp.close()
} catch (error) {
  console.error('driver failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  chrome.stop()
}
