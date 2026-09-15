/**
 * Verifies the sidebar file-tab menu inside a real, booted dsh web page.
 *
 * The plugin's bundle is already registered in the page's module loader, so this
 * loads it there, calls the menu component with a real tab address, and reports
 * what it renders — plus whether clicking each entry reaches the Host remote.
 * That covers the one thing the offline harness cannot: whether the component and
 * its injected context survive the real slot/runtime environment.
 *
 * Run with: node test/browser-menu.mjs "<url with token>" [out.png]
 *
 * @module test/browser-menu
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect, launchChrome, waitForEndpoint } from './cdp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const [url, outPath] = process.argv.slice(2)
if (url === undefined) {
  console.error('usage: node test/browser-menu.mjs "<url with token>" [out.png]')
  process.exit(2)
}

// The bundle, plus a tiny wrapper: register it under a private id with a fake
// react, then exercise the menu component and both of its actions.
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const harness = `
(async () => {
  const fakeReact = {
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    createElement: (type, props, children) => ({ type, props, children }),
  };
  // Execute the bundle source directly and capture the registration it performs,
  // so this does not depend on any module-loader API beyond \`load\` itself.
  let captured;
  const originalLoad = window.__ModuleLoader__.load;
  window.__ModuleLoader__.load = (entry) => { captured = entry; };
  try {
    new Function(${JSON.stringify(bundle)})();
  } finally {
    window.__ModuleLoader__.load = originalLoad;
  }
  if (captured === undefined) return { error: 'the bundle did not register itself' };
  const exported = captured.factory((spec) => {
    if (spec === 'react') return fakeReact;
    throw new Error('probe has no module table entry for ' + spec);
  });

  const address = exported.sessionFileAddress('session-probe', 'reports/报告 2026.pptx');

  const calls = [];
  const ctx = {
    sidebarRight: { openResource: (a) => calls.push(['sidebar', a]) },
    remote: { session: { openWorkspacePath: async (request) => { calls.push(['remote', JSON.stringify(request)]); return { ok: true, value: { opened: true } }; } } },
  };

  const render = (ownerProps) => {
    const node = exported.FileTabMenuItems(ownerProps);
    if (node === null) return null;
    return (node.children || []).filter(Boolean).map((child) => ({
      text: typeof child.children === 'string' ? child.children : (Array.isArray(child.children) ? child.children.join('') : null),
      action: child.props ? child.props['data-file-tab-action'] : null,
      role: child.props ? child.props.role : null,
    }));
  };

  const items = render({ tab: { contentId: address }, dismiss: () => calls.push(['dismiss']), ctx });
  const notAFile = render({ tab: { contentId: 'dsh-resource://guide/home' }, dismiss: () => {}, ctx });

  const node = exported.FileTabMenuItems({ tab: { contentId: address }, dismiss: () => calls.push(['dismiss']), ctx });
  const buttons = (node.children || []).filter((c) => c && c.props && c.props.onClick);
  for (const button of buttons) button.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 800));

  return {
    address,
    menuItems: items,
    nonFileTabRenders: notAFile,
    calls,
  };
})()
`

const chrome = launchChrome()
try {
  const cdp = await connect(await waitForEndpoint())
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sessionKey } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  const failures = []
  await cdp.send('Runtime.enable', {}, sessionKey)
  await cdp.send('Page.enable', {}, sessionKey)
  const pump = setInterval(() => {
    for (const event of cdp.events.splice(0)) {
      if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails
        failures.push(`${d.text} :: ${d.exception?.description ?? ''}`.slice(0, 300))
      }
    }
  }, 100)

  await cdp.send('Page.navigate', { url }, sessionKey)
  await new Promise((resolve) => setTimeout(resolve, 11000))

  const reply = await cdp.send('Runtime.evaluate', {
    expression: harness,
    returnByValue: true,
    awaitPromise: true,
  }, sessionKey)

  if (reply.exceptionDetails !== undefined) {
    console.log('probe threw:', JSON.stringify(reply.exceptionDetails).slice(0, 500))
  } else {
    console.log(JSON.stringify(reply.result?.value ?? reply, null, 1))
  }

  if (outPath !== undefined) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionKey)
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot -> ${outPath}`)
  }
  console.log(`uncaught=${String(failures.length)}`)
  for (const line of failures.slice(0, 6)) console.log(line)

  clearInterval(pump)
  await cdp.send('Target.closeTarget', { targetId })
  cdp.close()
} catch (error) {
  console.error('driver failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  chrome.stop()
}
