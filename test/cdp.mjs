/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Enough to open the local Web GUI, read its rendered state, and capture the
 * console — no browser-automation package required (this machine has Chrome and
 * Node, nothing else).
 *
 * Run with: node test/cdp.mjs <url> [--shot out.png]
 *
 * @module test/cdp
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333

/** Start Chrome with a throwaway profile and a debugging port. */
export function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'))
  const child = spawn(CHROME, [
    `--remote-debugging-port=${String(PORT)}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore', detached: false })
  return {
    child,
    profile,
    stop() {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        // Windows may still hold a handle; leaving it is harmless.
      }
    },
  }
}

/** Wait until the debugging endpoint answers and return the browser WebSocket URL. */
export async function waitForEndpoint(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/version`)
      if (response.ok) {
        const body = await response.json()
        return body.webSocketDebuggerUrl
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('chrome debugging endpoint did not come up')
}

/**
 * A tiny CDP session: send a command, await its reply.
 *
 * @param url - the browser-level WebSocket URL.
 * @returns the session handle.
 */
export async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 0
  const events = []
  socket.addEventListener('message', (message) => {
    const payload = JSON.parse(message.data)
    if (payload.id === undefined) {
      events.push(payload)
      return
    }
    const waiter = pending.get(payload.id)
    if (waiter === undefined) return
    pending.delete(payload.id)
    if (payload.error !== undefined) waiter.reject(new Error(JSON.stringify(payload.error)))
    else waiter.resolve(payload.result)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return {
    events,
    send(method, params = {}, sessionId) {
      const id = ++nextId
      const frame = { id, method, params }
      if (sessionId !== undefined) frame.sessionId = sessionId
      socket.send(JSON.stringify(frame))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close() {
      socket.close()
    },
  }
}
