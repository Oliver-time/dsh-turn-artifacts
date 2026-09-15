/**
 * Offline checks for the dsh-turn-artifacts client bundle.
 *
 * There is no browser and no `dsh` process here, so this file supplies the two
 * things the bundle assumes: a `window.__ModuleLoader__` `load()` sink that
 * materializes the factory with a small `require` table, and a fake client
 * context with just enough surface for `apply()`. Everything it asserts is then
 * behavior the browser would exercise, not a reimplementation of it.
 *
 * Two rules keep these checks honest, and both were learned the hard way:
 *
 * 1. **Build fixtures from the real wire shape.** A settled tool result nests its
 *    readable text one level below the block — see `wire.mjs`, whose header
 *    records the exact shape. The first version of this file put the text on the
 *    block itself, which matched a bug in the plugin instead of the wire: every
 *    check passed while, in production, the result half indexed nothing at all.
 *    Use the `toolResult()` builder below; never a hand-rolled block.
 * 2. **One check per behavior, including the boring ones.** The plugin is a pile
 *    of defensive lookups against services it does not own (`chatFileMentions`,
 *    `sessions`, the streamed event shape). Each degradation path — no provider,
 *    no loopback opener, no session lookup — has a check, because those paths are
 *    exactly the ones nobody notices breaking.
 *
 * The bundle is materialized once and shared by every check, so module-level
 * state (the turn artifact buckets) accumulates across checks. Checks that assert
 * on indexed paths therefore use their own turn number rather than assuming an
 * empty index; the turn-isolation check pins that behavior deliberately.
 *
 * Run with: `node test/harness.mjs`, or `npm test` for this plus the Host half.
 *
 * @module test/harness
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

// ── loader + platform seed table ───────────────────────────────────────────

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    },
  },
}

/** Every value a component pushed through a `useState` setter, in order. */
const stateUpdates = []

/**
 * React stand-in: enough of the API for the components this bundle defines.
 *
 * `createElement` keeps children in the shape the checks read (`props` and
 * `children`), `useEffect` is a no-op because nothing here mounts a tree, and
 * `useState` returns an inert pair so a component that keeps transient status
 * can still be called as a plain function — while recording what the setter was
 * given, which is how a check reads the menu's status line without a renderer.
 */
const react = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, children) {
    return { type, props, children }
  },
  useEffect() {},
  useState(initial) {
    return [
      typeof initial === 'function' ? initial() : initial,
      (next) => stateUpdates.push(typeof next === 'function' ? next(undefined) : next),
    ]
  },
}

const seed = new Map([['react', react]])
const required = []
const exportsOf = (() => {
  const source = readFileSync(bundlePath, 'utf8')
  // The bundle is a browser script, not an ES module: evaluate it as one.
  new Function(source)()
  assert.ok(registration !== undefined, 'bundle must register a factory')
  assert.equal(registration.id, 'dsh-turn-artifacts', 'bundle id must match the package name')
  return registration.factory((spec) => {
    required.push(spec)
    if (!seed.has(spec)) throw new Error(`require("${spec}") missed the module table`)
    return seed.get(spec)
  })
})()

// ── fake client context ────────────────────────────────────────────────────

/** Captures what the plugin registers so the test can drive it. */
function fakeContext() {
  const ctx = {
    definition: undefined,
    slot: undefined,
    slotComponent: undefined,
    disposers: [],
    listeners: new Map(),
    services: new Map(),
  }
  ctx.uiConversation = {
    events: {
      register(definition) {
        ctx.definition = definition
        return () => {}
      },
    },
  }
  ctx.slots = {
    inject(_hole, factory) {
      ctx.slot = factory()
      return () => {}
    },
    register(declaration, component) {
      ctx.slotDeclaration = declaration
      ctx.slotComponent = component
      return () => {}
    },
  }
  ctx.get = (name) => ctx.services.get(name)
  ctx.on = (event, listener) => {
    ctx.listeners.set(event, listener)
  }
  ctx.effect = (factory) => {
    const disposer = factory()
    if (typeof disposer === 'function') ctx.disposers.push(disposer)
    return () => {}
  }
  ctx.sessions = {
    current: () => 'session-1',
    list: {
      getSnapshot: () => ({
        byId: { 'session-1': { cwd: 'C:\\Users\\LIU\\Desktop\\lyh_robot' } },
      }),
    },
  }
  ctx.remote = {
    $host: { isLoopback: true },
    session: { canOpenWorkspacePath: async () => ({ ok: true, value: true }) },
  }
  return ctx
}

// ── helpers mirroring the real session wire ────────────────────────────────

let seq = 0
const nextSeq = () => ++seq

/** One `turn/start`. */
const turnStart = (turn) => ({ type: 'turn/start', seq: nextSeq(), data: { turn } })

/** One `tool/call` with model-produced JSON arguments. */
const toolCall = (turn, callId, name, args) => ({
  type: 'tool/call',
  seq: nextSeq(),
  data: { turn, callId, name, arguments: args === undefined ? '{}' : JSON.stringify(args) },
})

/**
 * One settled `tool/result`.
 *
 * The payload sits one level deeper than the block itself. Verified against real
 * session logs under the DSH sessions directory (session.jsonl.zstd):
 *
 *   content[0] = { type: 'tool-result', toolCallId, isError, content: [{ type: 'text', text }] }
 *
 * An earlier fixture put the text straight on the block, which matched a bug in
 * `resultText` instead of the wire, so every check below passed while the result
 * half of the plugin never indexed anything in production.
 */
const toolResult = (callId, text, isError = false) => ({
  type: 'tool/result',
  seq: nextSeq(),
  surfaceOp: 'append',
  data: {
    message: {
      source: { callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError,
        content: [{ type: 'text', text }],
      }],
    },
  },
})

/** Fold events through the registered definition exactly as the engine does. */
function fold(ctx, events) {
  const definition = ctx.definition
  assert.ok(definition !== undefined, 'plugin must register a conversation definition')
  let context
  let match
  for (const event of events) {
    const result = definition.match(event)
    if (result === null) continue
    if (result.role === 'start') {
      match = { event, role: 'start', location: undefined }
      context = {
        key: result.id,
        kind: definition.kind,
        id: result.id,
        matches: [match],
        start: match,
        state: definition.start(context, match, { previous: () => undefined }),
        current: new Map(),
      }
      continue
    }
    match = { event, role: 'update', location: undefined }
    context = { ...context, matches: [...context.matches, match], state: definition.update(context, match) }
  }
  const data = definition.buildLocationData(context, 'turn', null)
  return { context, data }
}

/** Owner currency the chat view passes to `forClosing` and to a turn-tail selector. */
const owner = (data) => ({
  turn: { turn: data.turn, data: { get: (key) => (key === data.key ? data.value : undefined) } },
  seq: 999,
  openFile: (path) => {
    opened.push(path)
    return Promise.resolve()
  },
})

/** Every `turnTail` selector consults this exact turn-data surface. */
const turnData = (data) => ({ get: (key) => (key === data.key ? data.value : undefined) })

const opened = []

/** A path-based opener used by the selector assertions. */
const openFile = (path) => {
  opened.push(path)
  return Promise.resolve()
}

const shipChatFileMentions = (ctx, paths) => {
  ctx.services.set('chatFileMentions', {
    forClosing() {
      return {
        resolve(token) {
          const hit = paths.find((path) => path === token || path.split(/[\\/]/).pop() === token)
          return hit === undefined
            ? undefined
            : { open: () => openFile(hit), label: `打开 ${hit}`, title: hit }
        },
      }
    },
  })
}

// ── the turn from the report ───────────────────────────────────────────────

const SCRIPT = 'C:\\Users\\LIU\\Desktop\\lyh_robot\\assets\\polish_v13.py'
const PPTX = 'C:\\Users\\LIU\\Desktop\\lyh_robot\\_文档\\暑期汇报_20260909\\暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx'
const PNG = 'C:\\Users\\LIU\\Desktop\\lyh_robot\\_文档\\暑期汇报_20260909\\assets\\_v13_overview.png'
const MD = 'C:\\Users\\LIU\\Desktop\\lyh_robot\\_文档\\暑期汇报_20260909\\版式打磨说明_v13.md'

const reportTurn = () => [
  turnStart(1),
  toolCall(1, 'call-write-md', 'write', { file_path: MD, content: '# 版式打磨说明' }),
  toolResult('call-write-md', 'Wrote 13 pages of notes.'),
  toolCall(1, 'call-write-py', 'write', { file_path: SCRIPT, content: 'print(1)' }),
  toolResult('call-write-py', 'File created.'),
  toolCall(1, 'call-run', 'pwsh', {
    command: '"C:\\Users\\LIU\\.local\\bin\\python3.12.exe" assets\\polish_v13.py',
    workdir: 'C:\\Users\\LIU\\Desktop\\lyh_robot',
  }),
  toolResult('call-run', JSON.stringify({
    written: PPTX,
    pages: 13,
    bytes: 2750000,
    chart: PNG,
    log: '_文档\\暑期汇报_20260909\\build.log',
    ignored: 'C:\\Users\\LIU\\.local\\bin\\python3.12.exe',
  })),
]

// ── checks ────────────────────────────────────────────────────────────────

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('bundle shape', () => {
  assert.deepEqual(required, ['react'], 'the bundle must stay on the platform seed table')
  assert.equal(typeof exportsOf.apply, 'function', 'apply must be exported')
  assert.ok(Array.isArray(exportsOf.inject), 'inject must be an array')
  assert.equal(registration.id, 'dsh-turn-artifacts')
})

check('path extraction keeps artifacts and drops toolchains', () => {
  const fs = exportsOf.collectPaths
  const found = fs(JSON.stringify({
    written: PPTX,
    chart: PNG,
    log: '_文档\\暑期汇报_20260909\\build.log',
    interpreter: 'C:\\Users\\LIU\\.local\\bin\\python3.12.exe',
    url: 'https://example.com/x.svg',
  }))
  const keys = found.map((path) => path.replace(/\\/g, '/').toLowerCase())
  assert.ok(keys.includes('c:/users/liu/desktop/lyh_robot/_文档/暑期汇报_20260909/暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx'), 'the produced pptx is an artifact')
  assert.ok(keys.includes('c:/users/liu/desktop/lyh_robot/_文档/暑期汇报_20260909/assets/_v13_overview.png'), 'the produced png is an artifact')
  assert.ok(!keys.some((key) => key.includes('python3.12.exe')), 'a toolchain executable is not an artifact')
  assert.ok(!keys.some((key) => key.includes('example.com')), 'a url is not an artifact')
})

check('a bare file name in result text is not located', () => {
  const fs = exportsOf.collectPaths
  assert.deepEqual(
    fs(JSON.stringify({ written: '暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx' })),
    [],
    'a name with no directory carries no location and must not become a workspace-relative link',
  )
  assert.deepEqual(fs('见 image.png 与 out/chart.png'), ['out/chart.png'], 'a name with a directory component is still indexed')
  assert.deepEqual(fs('C:\\a\\b\\x.pptx'), ['C:/a/b/x.pptx'], 'an absolute path is indexed on its own')
})

check('an absolute candidate wins over a same-named relative one', () => {
  const resolve = exportsOf.resolveToken
  const paths = ['build/report.pdf', 'C:/work/keep/report.pdf']
  assert.equal(resolve(paths, 'report.pdf'), 'C:/work/keep/report.pdf', 'the recorded absolute path is preferred')
  assert.equal(resolve(['build/report.pdf'], 'report.pdf'), 'build/report.pdf', 'a workspace-relative path still works alone')
  assert.equal(resolve(['assets/polish_v13.py'], 'assets\\polish_v13.py'), 'assets/polish_v13.py', 'separator spelling does not defeat a suffix match')
})

check('mutation vocabulary mirrors the shipped one', () => {
  const mutationPath = exportsOf.mutationPath
  assert.equal(mutationPath('write', JSON.stringify({ file_path: MD, content: 'x' })), MD)
  assert.equal(mutationPath('write', JSON.stringify({ file_path: MD })), null, 'a write without content is not a mutation')
  assert.equal(mutationPath('edit', JSON.stringify({ file_path: MD, old_string: 'a', new_string: 'b' })), MD)
  assert.equal(mutationPath('edit', JSON.stringify({ file_path: MD, old_string: 'a', new_string: 'a' })), null, 'a no-op edit is not a mutation')
  assert.equal(mutationPath('str_replace_editor', JSON.stringify({ command: 'view', path: MD })), null, 'a read-only editor command is not a mutation')
  assert.equal(mutationPath('read', JSON.stringify({ file_path: MD })), null)
  assert.equal(mutationPath('pwsh', JSON.stringify({ command: 'python x.py' })), null)
})

check('token resolution: exact, basename, suffix, inert', () => {
  const resolve = exportsOf.resolveToken
  const paths = [PPTX, PNG, SCRIPT]
  assert.equal(resolve(paths, PPTX), PPTX, 'an exact path resolves')
  assert.equal(resolve(paths, '暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx'), PPTX, 'a unique basename resolves')
  assert.equal(resolve(paths, '_v13_overview.png'), PNG, 'the chart basename resolves')
  assert.equal(resolve(paths, 'assets\\polish_v13.py'), SCRIPT, 'a relative suffix resolves')
  assert.equal(resolve(paths, 'assets/polish_v13.py'), SCRIPT, 'either separator spelling resolves')
  assert.equal(resolve(paths, 'polish_v13'), undefined, 'a token naming no file stays inert')
  assert.equal(resolve(paths, 'version 13'), undefined, 'prose stays inert')
  assert.equal(resolve(paths, 'C:\\nope\\missing.pptx'), undefined, 'a path with no evidence stays inert')
})

check('a failed command contributes nothing', () => {
  const ctx = fakeContext()
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)
  const failed = toolResult('call-run', JSON.stringify({ error: PPTX }), true)
  const { data } = fold(ctx, [
    turnStart(1),
    toolCall(1, 'call-run', 'pwsh', { command: 'python assets/polish_v13.py' }),
    failed,
  ])
  const keys = data.value.artifacts.map((path) => path.replace(/\\/g, '/').toLowerCase())
  assert.ok(keys.includes('assets/polish_v13.py'), 'the command argument is indexed')
  assert.ok(!keys.some((key) => key.endsWith('.pptx')), 'a failed result contributes no artifact')
})

check('the report turn produces clickable mentions', () => {
  const ctx = fakeContext()
  shipChatFileMentions(ctx, [MD])
  const applied = exportsOf.apply(ctx)
  assert.equal(applied, undefined)
  assert.equal(exportsOf.apply.length, 1, 'apply takes exactly the context')

  const { data } = fold(ctx, reportTurn())
  const artifacts = data.value.artifacts.map((path) => path.replace(/\\/g, '/').toLowerCase())
  assert.ok(artifacts.includes(PPTX.replace(/\\/g, '/').toLowerCase()), 'the pptx is indexed from the tool result')
  assert.ok(artifacts.includes(PNG.replace(/\\/g, '/').toLowerCase()), 'the png is indexed from the tool result')
  assert.ok(artifacts.includes(SCRIPT.replace(/\\/g, '/').toLowerCase()), 'the script is indexed from the call arguments')
  assert.ok(artifacts.includes('assets/polish_v13.py'), 'the command argument is indexed too')

  // The chat view asks the service for this closing message.
  const closing = ctx.services.get('chatFileMentions').forClosing(owner(data))
  assert.ok(closing !== undefined, 'the shipped provider still answers')

  const pptx = closing.resolve('暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx')
  assert.ok(pptx !== undefined, 'the pptx basename is now clickable — this is the reported bug')
  assert.match(pptx.title, /v13\.pptx/, 'the link title carries the full path')
  pptx.open()
  const last = opened.at(-1)
  assert.ok(last.endsWith('v13.pptx'), 'activating the link opens the file')
  assert.ok(last.replace(/\\/g, '/').startsWith('C:/Users/LIU/Desktop/lyh_robot'), 'the absolute path is preserved')

  assert.ok(closing.resolve('_v13_overview.png') !== undefined, 'the chart is clickable by basename')
  assert.ok(closing.resolve(MD) !== undefined, 'the shipped vocabulary still answers its own file')
  assert.equal(closing.resolve('版式打磨说明'), undefined, 'unknown prose stays inert')
})

check('authored files stay with the shipped row', () => {
  const ctx = fakeContext()
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)
  const { data } = fold(ctx, reportTurn())
  const authored = data.value.authored.map((path) => path.replace(/\\/g, '/').toLowerCase())
  assert.deepEqual(
    authored,
    [MD.replace(/\\/g, '/').toLowerCase(), SCRIPT.replace(/\\/g, '/').toLowerCase()],
    'the two files a file tool wrote are authored, in tool order',
  )
  assert.ok(!authored.some((path) => path.endsWith('.pptx')), 'the script product is not authored')

  const selected = ctx.slotDeclaration.select(owner(data))
  assert.ok(selected !== null, 'the artifact row claims the turn')
  const keys = selected.artifacts.map((path) => path.replace(/\\/g, '/').toLowerCase())
  const authoredKeys = new Set(selected.authored.map((path) => path.replace(/\\/g, '/').toLowerCase()))
  const chips = keys.filter((key) => !authoredKeys.has(key))
  assert.ok(chips.includes(PPTX.replace(/\\/g, '/').toLowerCase()), 'the pptx is offered as a chip')
  assert.ok(!chips.includes(MD.replace(/\\/g, '/').toLowerCase()), 'the authored md is not duplicated')
  assert.ok(selected.cwd === undefined || typeof selected.cwd === 'string', 'the selector carries a workspace root when one is known')
})

check('launching a script does not count as producing its source', () => {
  const ctx = fakeContext()
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)
  const { data } = fold(ctx, [
    turnStart(2),
    toolCall(2, 'call-run', 'pwsh', { command: 'python assets/make_trend_chart_v2.py', workdir: 'C:\\Users\\LIU\\Desktop\\lyh_robot' }),
    toolResult('call-run', 'chart written to assets/trend_v2.png'),
  ])
  const keys = data.value.artifacts.map((path) => path.replace(/\\/g, '/').toLowerCase())
  assert.ok(keys.includes('assets/make_trend_chart_v2.py'), 'the launched script is indexed')
  assert.ok(keys.includes('assets/trend_v2.png'), 'the produced chart is indexed')
  assert.equal(data.value.authored.length, 0, 'nothing was authored by a file tool')

  const selected = ctx.slotDeclaration.select(owner(data))
  const authoredKeys = new Set(selected.authored.map((path) => path.replace(/\\/g, '/').toLowerCase()))
  const chips = selected.artifacts
    .map((path) => path.replace(/\\/g, '/').toLowerCase())
    .filter((path) => !authoredKeys.has(path))
  assert.ok(chips.includes('assets/make_trend_chart_v2.py'), 'the launched script is offered as a chip')
  assert.ok(chips.includes('assets/trend_v2.png'), 'the produced chart is offered as a chip')
})

check('a write-then-edit file is one entry, and a failed mutation is none', () => {
  const ctx = fakeContext()
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)
  const { data } = fold(ctx, [
    turnStart(3),
    toolCall(3, 'c1', 'write', { file_path: MD, content: 'x' }),
    toolResult('c1', 'ok'),
    toolCall(3, 'c2', 'edit', { file_path: MD, old_string: 'x', new_string: 'y' }),
    toolResult('c2', 'ok'),
    toolCall(3, 'c3', 'write', { file_path: SCRIPT, content: 'print(1)' }),
    toolResult('c3', 'permission denied', true),
  ])
  assert.deepEqual(data.value.authored, [MD], 'a file written then edited is one entry, a failed write is none')
})

check('turn isolation and disposer', () => {
  const ctx = fakeContext()
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)
  const first = fold(ctx, reportTurn())
  const second = fold(ctx, [turnStart(2), toolCall(2, 'c9', 'write', { file_path: SCRIPT, content: 'x' }), toolResult('c9', 'ok')])
  assert.equal(first.data.turn, 1)
  assert.equal(second.data.turn, 2)
  const closing = ctx.services.get('chatFileMentions').forClosing(owner(first.data))
  assert.ok(closing.resolve('_v13_overview.png') !== undefined, 'turn 1 keeps its own artifacts')
  const other = ctx.services.get('chatFileMentions').forClosing(owner(second.data))
  assert.equal(other.resolve('_v13_overview.png'), undefined, 'turn 2 does not inherit turn 1 artifacts')

  for (const dispose of ctx.disposers) dispose()
  assert.ok(ctx.disposers.length > 0, 'the wrapper is owned by a disposer')
})

check('a missing shipped provider degrades to this plugin alone', () => {
  const ctx = fakeContext()
  const applied = exportsOf.apply(ctx)
  assert.equal(applied, undefined, 'a provider-less browser must not break mounting')
  const { data } = fold(ctx, reportTurn())
  const selected = ctx.slotDeclaration.select(owner(data))
  assert.ok(selected !== null, 'the artifact row still claims the turn')

  // A provider that mounts later is picked up on the next connection reset.
  shipChatFileMentions(ctx, [])
  const reset = ctx.listeners.get('connection/reset')
  assert.equal(typeof reset, 'function', 'the plugin listens for a reconnect')
  reset()
  const closing = ctx.services.get('chatFileMentions').forClosing(owner(data))
  assert.ok(closing.resolve('_v13_overview.png') !== undefined, 'the widened resolver is installed after the reset')
})

check('a non-loopback browser is not offered the chip row', () => {
  const ctx = fakeContext()
  ctx.remote = { $host: { isLoopback: false }, session: {} }
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)
  const { data } = fold(ctx, reportTurn())
  assert.equal(ctx.slotDeclaration.select(owner(data)), null, 'no row where the Host cannot open files')
})

// ── history autofill ───────────────────────────────────────────────────────

/**
 * One fake Session with the paging surface the history fill drives.
 *
 * Mirrors the fields the client adapter exposes: `open()`, `hasMore`, `baseSeq`,
 * and `loadOlder()`. `pages` counts how many pages remain before the window
 * reaches the start of the log; `stall` makes a page succeed without moving.
 */
function fakeSession(id, pages, stall = false) {
  return {
    id,
    baseSeq: 1000,
    hasMore: pages > 0,
    openCalls: 0,
    loadCalls: 0,
    pages,
    async open() {
      this.openCalls += 1
    },
    async loadOlder() {
      this.loadCalls += 1
      if (stall || !this.hasMore) return
      this.baseSeq -= 50
      this.pages -= 1
      this.hasMore = this.pages > 0
    },
  }
}

/**
 * A fake `sessions` service: a list store plus both session lookups.
 *
 * The real service exposes the documented `binding(id)` (whose `.session` is the
 * outward face) and the concrete-only `resolve(id)` (whose `.session` is the same
 * object). Both are faked here so a check can delete either one and prove the
 * plugin still finds the session through the other.
 */
function fakeSessions(initial) {
  const sessions = new Map(Object.entries(initial))
  const listeners = new Set()
  const state = { current: Object.keys(initial)[0] }
  const resolve = (id) => {
    const session = sessions.get(id)
    return session === undefined ? undefined : { session }
  }
  return {
    sessions,
    listenerCount: () => listeners.size,
    /** Fire the subscription without changing the selection, as the store does. */
    notify() {
      for (const listener of listeners) listener()
    },
    setCurrent(id) {
      state.current = id
      for (const listener of listeners) listener()
    },
    list: {
      getSnapshot: () => ({ current: state.current }),
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    binding: resolve,
    resolve,
  }
}

/** A fakeContext whose `sessions` service can actually page. */
function autofillContext(sessions) {
  const ctx = fakeContext()
  ctx.sessions = sessions
  ctx.disposeAll = () => {
    for (const dispose of ctx.disposers) dispose()
    ctx.disposers.length = 0
  }
  return ctx
}

/** Let the fill's promise chain run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Wait until a fake session stops paging, or a deadline passes.
 *
 * The fill is paced now — a frame plus a pause between pages — so a single
 * `settle()` would only ever observe its first page. Waiting for the loop to
 * finish is also the check that pacing does not wedge it.
 *
 * @param session - the fake session to watch.
 * @param timeoutMs - how long to wait before giving up.
 * @returns true when the session reached the start of its history.
 */
async function waitForFill(session, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (session.hasMore !== true) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return session.hasMore !== true
}

check('history autofill pages an opened session back to the start', async () => {
  const sessions = fakeSessions({ s1: fakeSession('s1', 4) })
  assert.equal(await exportsOf.fillHistory(sessions, 's1', undefined), 4, 'every remaining page is pulled')
  const session = sessions.sessions.get('s1')
  assert.equal(session.loadCalls, 4, 'one loadOlder per page')
  assert.equal(session.hasMore, false, 'the window now reaches the start')
  assert.equal(session.openCalls, 1, 'the session is opened first')

  assert.equal(await exportsOf.fillHistory(fakeSessions({ s1: fakeSession('s1', 0) }), 's1', undefined), 0, 'a full window needs no pages')
  assert.equal(
    await exportsOf.fillHistory(fakeSessions({ s1: fakeSession('s1', 500) }), 's1', 7),
    7,
    'the page cap bounds a huge log',
  )
})

check('the fill paces itself between pages instead of running flat out', async () => {
  // The 0.5.0 fill pulled sixty pages back to back; measured in a real browser it
  // held the main thread for ~2.2s of every 2.5s and left a 34.6k-node page
  // behind. Pacing is the brake, so it has to be observable, not incidental.
  const order = []
  const sessions = fakeSessions({ s1: fakeSession('s1', 3) })
  const pages = await exportsOf.fillHistory(sessions, 's1', undefined, {
    afterPage: async (page, elapsed) => {
      order.push([page, typeof elapsed === 'number' && elapsed >= 0])
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
    shouldContinue: () => true,
  })
  assert.equal(pages, 3, 'every page still arrives')
  assert.deepEqual(order, [[1, true], [2, true], [3, true]], 'each page is followed by its pause')

  const stopped = fakeSessions({ s1: fakeSession('s1', 9) })
  const pulled = await exportsOf.fillHistory(stopped, 's1', undefined, { shouldContinue: () => false })
  assert.equal(pulled, 0, 'a refusal before the first page pulls nothing')
  assert.equal(stopped.sessions.get('s1').loadCalls, 0, 'and never touches the transport')

  const half = fakeSessions({ s1: fakeSession('s1', 9) })
  let seen = 0
  const halfPulled = await exportsOf.fillHistory(half, 's1', undefined, {
    shouldContinue: () => (seen += 1) <= 2,
  })
  assert.equal(halfPulled, 2, 'a refusal mid-fill stops it there')
})

check('the pause grows with what the last page cost', () => {
  assert.equal(exportsOf.fillPause(0), 250, 'a free page still yields the minimum pause')
  assert.equal(exportsOf.fillPause(100), 550, 'an expensive page buys proportionally more')
  assert.equal(exportsOf.fillPause(99_999), 4000, 'and the back-off is capped so progress continues')
  assert.equal(exportsOf.fillPause(undefined), 250, 'an unmeasurable page is treated as free')
  assert.equal(exportsOf.fillPause(-5), 250, 'a nonsensical measurement cannot shorten the pause')
})

check('history autofill stops on a stalled page and tolerates what it cannot page', async () => {
  assert.equal(
    await exportsOf.fillHistory(fakeSessions({ s1: fakeSession('s1', 5, true) }), 's1', undefined),
    1,
    'a page that makes no progress ends the loop',
  )
  const sessions = fakeSessions({ s1: fakeSession('s1', 3) })
  assert.equal(await exportsOf.fillHistory(sessions, 'missing', undefined), 0, 'an unresolvable id is not an error')
  assert.equal(await exportsOf.fillHistory(undefined, 's1', undefined), 0, 'a missing service is tolerated')
  assert.equal(await exportsOf.fillHistory({}, 's1', undefined), 0, 'a service without resolve() is tolerated')

  const broken = fakeSession('s1', 3)
  broken.open = async () => {
    throw new Error('offline')
  }
  assert.equal(await exportsOf.fillHistory(fakeSessions({ s1: broken }), 's1', undefined), 0)
  assert.equal(broken.loadCalls, 0, 'no page is attempted after a failed open')
})

check('mounting the plugin fills the current session and stops on disposal', async () => {
  // The fill runs by default, and that is load-bearing: the client opens a
  // conversation with only its newest 50 events, so in any long conversation the
  // tool result that produced a file sits outside the window and the plugin would
  // never see the evidence. A disabled fill once made historical mentions stop
  // being links — this check keeps the fill wired.
  const sessions = fakeSessions({ s1: fakeSession('s1', 3), s2: fakeSession('s2', 2) })
  const ctx = autofillContext(sessions)
  exportsOf.apply(ctx)

  await settle()
  assert.equal(sessions.listenerCount(), 1, 'the plugin subscribes to the session list')
  assert.equal(await waitForFill(sessions.sessions.get('s1')), true, 'the fill finishes on its own')
  assert.equal(sessions.sessions.get('s1').loadCalls, 3, 'the current session is paged back')

  sessions.setCurrent('s2')
  assert.equal(await waitForFill(sessions.sessions.get('s2')), true, 'the next session is filled too')
  assert.equal(sessions.sessions.get('s2').loadCalls, 2, 'a session opened later is paged too')

  ctx.disposeAll()
  assert.equal(sessions.listenerCount(), 0, 'disposal releases the subscription')
})

check('one session is filled at a time, and a switch abandons the fill', async () => {
  // Two rules that 0.5.0 lacked. The list store notifies on every selection and
  // membership change, and the old code claimed a session only after its fill
  // resolved, so a notification arriving mid-fill started a second full fill of the
  // same conversation on top of the first. And a fill kept paging a conversation
  // the reader had already left, which is pure cost on the page they are watching.
  const sessions = fakeSessions({ s1: fakeSession('s1', 40), s2: fakeSession('s2', 1) })
  const ctx = autofillContext(sessions)
  exportsOf.apply(ctx)

  // Notify repeatedly while the first fill is still running.
  for (let i = 0; i < 5; i += 1) {
    sessions.notify()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const first = sessions.sessions.get('s1')
  assert.equal(first.openCalls, 1, 'the repeated notifications do not start a second fill')

  sessions.setCurrent('s2')
  await waitForFill(sessions.sessions.get('s2'))
  const abandonedAt = first.loadCalls
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(first.loadCalls, abandonedAt, 'the abandoned fill stops paging the session left behind')
  assert.ok(abandonedAt < 40, 'it really was abandoned mid-history')
  assert.equal(sessions.sessions.get('s2').loadCalls, 1, 'the new session is filled instead')

  ctx.disposeAll()
})

check('history autofill reaches a session through either lookup', async () => {
  // `binding(id)` is the documented route; a service exposing only the
  // concrete `resolve(id)` must still fill, and vice versa.
  const viaBinding = fakeSessions({ s1: fakeSession('s1', 1) })
  delete viaBinding.resolve
  assert.equal(await exportsOf.fillHistory(viaBinding, 's1', undefined), 1, 'binding(id).session is enough')

  const viaResolve = fakeSessions({ s1: fakeSession('s1', 1) })
  delete viaResolve.binding
  assert.equal(await exportsOf.fillHistory(viaResolve, 's1', undefined), 1, 'resolve(id).session is enough')

  const neither = { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }
  assert.equal(await exportsOf.fillHistory(neither, 's1', undefined), 0, 'a service with neither lookup fills nothing')
  const covered = fakeSessions({ s1: fakeSession('s1', 1) })
  covered.binding = () => undefined
  assert.equal(await exportsOf.fillHistory(covered, 's1', undefined), 1, 'an undefined binding falls back')
})

check('a window that opens mid-turn does not break the definition', () => {
  // The regression that emptied whole transcripts. A session's loaded window can
  // begin in the middle of a turn — the `turn/start` that would have seeded this
  // definition's state sits outside the page — so `update` and
  // `buildLocationData` both run with `state` still undefined. Reading
  // `state.turn` there threw "Cannot read properties of undefined (reading
  // 'turn')", which killed the session event feed and left the chat area blank.
  // It showed up on big conversations only because a window is most likely to
  // start mid-turn in a long log.
  const definition = fakeContext()
  exportsOf.apply(definition)
  const artifactDefinition = definition.definition
  assert.ok(artifactDefinition !== undefined, 'the definition must be registered')

  const midTurnContext = {
    key: 'turn-artifacts:7',
    kind: 'turn-artifacts',
    id: '7',
    matches: [{ event: toolResult('call-x', 'wrote C:\\out\\deep\\report.pdf'), role: 'update', location: undefined }],
    start: undefined,
    state: undefined,
    current: new Map(),
  }

  // update: an update-role match arriving before any seed must be tolerated.
  assert.doesNotThrow(() => {
    artifactDefinition.update(midTurnContext, midTurnContext.matches[0])
  }, 'update must survive an undefined phase instead of throwing')

  // buildLocationData: same guard, and it must publish nothing rather than
  // guess a turn number the assembler would reject.
  let data
  assert.doesNotThrow(() => {
    data = artifactDefinition.buildLocationData(midTurnContext, 'turn', null)
  }, 'buildLocationData must survive an undefined state')
  assert.equal(data, null, 'no turn number is available, so nothing is published')

  // A location that does carry the turn still works, which is how a mid-turn
  // window gets its artifacts published.
  const withLocation = {
    ...midTurnContext,
    start: {
      event: { type: 'turn/start', seq: 1, data: { turn: 7 } },
      role: 'start',
      location: { kind: 'turn', turn: 7 },
    },
  }
  const published = artifactDefinition.buildLocationData(withLocation, 'turn', null)
  assert.ok(published === null || published.kind === 'turn', 'a located turn either publishes or declines, never throws')
})

check('the mention wrapper forwards every argument the view passes', () => {
  // The shipped call grew a second parameter — `forClosing(owner, sessionId)` —
  // when deliverables learned to open files as `dsh-resource://` addresses in the
  // right Sidebar. A wrapper that named only `owner` handed the shipped resolver
  // an undefined session, so the official vocabulary answered nothing: wrapping
  // the service broke the very feature it extends. This pins the forwarding.
  const ctx = fakeContext()
  const seen = []
  ctx.services.set('chatFileMentions', {
    forClosing(...args) {
      seen.push(args)
      return { resolve: () => undefined }
    },
  })
  exportsOf.apply(ctx)

  const wrapped = ctx.services.get('chatFileMentions').forClosing
  assert.notEqual(typeof wrapped, 'undefined')
  const turnDataArg = { turn: { turn: 4242, data: { get: () => undefined } }, seq: 1, openFile: () => {} }
  wrapped(turnDataArg, 'session-abc')

  assert.equal(seen.length, 1, 'the shipped provider is still called')
  assert.equal(seen[0].length, 2, 'both arguments arrive, not just the first')
  assert.equal(seen[0][0], turnDataArg, 'the owner is forwarded by identity')
  assert.equal(seen[0][1], 'session-abc', 'the sessionId is forwarded unchanged')

  // A provider that takes one argument must keep working, and a malformed owner
  // must not throw out of the wrapper.
  const oneArg = fakeContext()
  oneArg.services.set('chatFileMentions', { forClosing: (only) => ({ resolve: () => undefined, only }) })
  exportsOf.apply(oneArg)
  assert.doesNotThrow(() => oneArg.services.get('chatFileMentions').forClosing(turnDataArg, 's'))
  assert.doesNotThrow(() => oneArg.services.get('chatFileMentions').forClosing(undefined, 's'))
  assert.doesNotThrow(() => oneArg.services.get('chatFileMentions').forClosing({}, 's'))
})

// ── sidebar integration ───────────────────────────────────────────────────

check('file addresses round-trip through build and parse', () => {
  const build = exportsOf.sessionFileAddress
  const parse = exportsOf.parseFileAddress

  const address = build('session-1', 'assets\\sub dir\\报告.pdf')
  assert.equal(
    address,
    'dsh-resource://file/session/session-1/assets/sub%20dir/%E6%8A%A5%E5%91%8A.pdf',
    'separators stay separators; a name is encoded segment by segment',
  )
  assert.deepEqual(parse(address), { scope: 'session', sessionId: 'session-1', path: 'assets/sub dir/报告.pdf' })
  assert.deepEqual(parse(build('s', 'C:/Users/LIU/out/x.pptx')), { scope: 'session', sessionId: 's', path: 'C:/Users/LIU/out/x.pptx' }, 'a drive letter survives encoding')
  assert.deepEqual(parse('dsh-resource://file/absolute/C:/x/y.pptx'), { scope: 'absolute', path: 'C:/x/y.pptx' })
  assert.deepEqual(parse('dsh-resource://file/absolute//server/share/x.bin'), { scope: 'absolute', path: '//server/share/x.bin' }, 'a UNC path keeps its leading slashes')

  // Anything that is not a file address must decline: this is how a menu item
  // decides not to offer file actions for the guide or a page tab.
  for (const notAFile of ['', 'dsh-resource://guide/home', 'dsh-resource://file/session/', 'dsh-resource://file/session/s', 'https://example.com/x', undefined, 42]) {
    assert.equal(parse(notAFile), undefined, `${String(notAFile)} is not a file address`)
  }
})

check('file menu items decline for tabs that are not files', () => {
  const build = exportsOf.sessionFileAddress
  const items = exportsOf.FileTabMenuItems
  const ctx = { remote: { session: { openWorkspacePath: async () => ({ ok: true }) } } }

  // A page tab: nothing to offer.
  assert.equal(items({ tab: { contentId: 'dsh-resource://guide/home' }, dismiss: () => {}, ctx }), null)
  assert.equal(items({ tab: { contentId: 'nonsense' }, dismiss: () => {}, ctx }), null)
  assert.equal(items({ tab: {}, dismiss: () => {}, ctx }), null)

  // A file tab: two entries, and the owner share is read either way round.
  const tab = { contentId: build('s1', 'out/report.pdf') }
  const element = items({ tab, dismiss: () => {}, ctx })
  assert.notEqual(element, null, 'a file tab gets actions')
  const children = (element.children ?? []).filter(Boolean)
  assert.equal(children.length, 2, 'exactly the two actions before any status line')
  assert.deepEqual(children.map((child) => child.props['data-file-tab-action']), ['open', 'reveal'])
})

check('the plugin resolver answers before the shipped one', () => {
  // The `present` tool puts script output into the shipped vocabulary, and that
  // vocabulary opens it with the native opener — into PowerPoint, not the
  // Sidebar. So for a path this plugin indexed, its resolver must win.
  const ctx = fakeContext()
  const coreAnswers = []
  ctx.services.set('chatFileMentions', {
    forClosing: () => ({
      resolve(token) {
        coreAnswers.push(token)
        return { open: () => {}, label: 'shipped', title: 'shipped' }
      },
    }),
  })
  exportsOf.apply(ctx)

  const ownerShape = {
    turn: { turn: 1, data: { get: () => undefined } },
    seq: 10,
    sessionId: 'session-1',
    openFile: () => {},
  }
  const closing = ctx.services.get('chatFileMentions').forClosing(ownerShape, 'session-1')

  // Turn 1 is the report turn folded by an earlier check; the pptx is in it.
  const mine = closing.resolve('暑期科研汇报_正式流程图版_甘雨模板_5分钟版_v13.pptx')
  assert.ok(mine !== undefined, 'the pptx resolves')
  assert.notEqual(mine.title, 'shipped', 'this plugin answered first, not the shipped resolver')
  assert.match(mine.title, /v13\.pptx/)
  assert.equal(coreAnswers.length, 0, 'the shipped resolver is not even consulted for an indexed path')

  // A token only the shipped resolver knows still reaches it.
  const theirs = closing.resolve('something-only-they-know.md')
  assert.equal(theirs.title, 'shipped', 'an unindexed token still falls through')
  assert.deepEqual(coreAnswers, ['something-only-they-know.md'])
})

check('the artifact row routes into the sidebar when one exists', () => {
  const opened = []
  const ctx = fakeContext()
  ctx.sidebarRight = { openResource: (address) => opened.push(address) }
  const sessions = fakeSessions({ 'session-1': fakeSession('session-1', 0) })
  ctx.sessions = sessions
  shipChatFileMentions(ctx, [])
  exportsOf.apply(ctx)

  const { data } = fold(ctx, reportTurn())
  const selected = ctx.slotDeclaration.select({ ...owner(data), sessionId: 'session-1' })
  assert.ok(selected !== null, 'the row still claims the turn')
  assert.equal(typeof selected.openInSidebar, 'function', 'the row carries a sidebar route when one exists')
  selected.openInSidebar('out/chart.png')
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^dsh-resource:\/\/file\/session\/session-1\//, 'it opens a file address, not a bare path')
})

/**
 * A context that behaves like the real one: reading an undeclared property throws.
 *
 * This is the single most expensive shape to get wrong. A cordis client context is
 * a Proxy whose `get` throws `cannot get property "<name>" without inject` for any
 * service the calling fiber did not declare — the throw happens on the *read*, so
 * `ctx.sidebarRight?.open`, `ctx.off?.(...)`, and even a `try` around the caller's
 * own statement all fail the same way. Version 0.5.0 read two such properties and
 * shipped both bugs: every mention click died inside `sidebarOpener`, and every
 * connection reset threw out of the mention wrapper's rollback.
 *
 * @param ctx - a plain fake context to wrap.
 * @param allowed - names the plugin is allowed to read directly.
 * @returns the guarded context, plus a record of what was asked for.
 */
function guardedContext(ctx, allowed) {
  const asked = []
  const guarded = new Proxy(ctx, {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || property.startsWith('_') || Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver)
      }
      asked.push(property)
      if (allowed.includes(property)) return target[property]
      throw new Error(`cannot get property "${property}" without inject`)
    },
  })
  return { ctx: guarded, asked }
}

/** The services this plugin declares, mirroring its own `inject` export. */
const DECLARED = ['slots', 'uiConversation', 'remote', 'sessions']

check('an undeclared service is read through ctx.get, never as a property', () => {
  // The regression that killed every mention click. `sidebarRight` is provided by
  // the sidebar package and is deliberately absent from this plugin's `inject` —
  // declaring it would make the whole plugin wait for a sidebar that headless and
  // older deployments never provide — so the only safe spelling is `ctx.get`.
  const opened = []
  const base = fakeContext()
  base.services.set('sidebarRight', { openResource: (address) => opened.push(address) })
  const { ctx } = guardedContext(base, DECLARED)

  assert.throws(() => ctx.sidebarRight, /without inject/, 'the real guard is what this fake models')
  const found = exportsOf.optionalService(ctx, 'sidebarRight')
  assert.equal(typeof found?.openResource, 'function', 'ctx.get still finds it')
  assert.equal(exportsOf.optionalService(ctx, 'nothing-registers-this'), undefined, 'an absent service reads as undefined, not as a throw')

  shipChatFileMentions(base, [])
  exportsOf.apply(ctx)
  const { data } = fold(base, reportTurn())
  const selected = base.slotDeclaration.select({ ...owner(data), sessionId: 'session-1' })
  assert.ok(selected !== null)
  selected.openInSidebar('out/chart.png')
  assert.equal(opened.length, 1, 'the sidebar route survives the guard')
})

check('a mention click opens the sidebar, and never dies inside the opener', () => {
  const opened = []
  const base = fakeContext()
  base.services.set('sidebarRight', { openResource: (address) => opened.push(address) })
  base.services.set('chatFileMentions', { forClosing: () => undefined })
  const { ctx } = guardedContext(base, DECLARED)
  exportsOf.apply(ctx)
  // Fold the report turn into this context: the artifact index is per definition
  // instance, so a check must not borrow another check's fold.
  const { data } = fold(base, reportTurn())
  const pptx = data.value.artifacts.find((path) => path.endsWith('.pptx'))
  assert.ok(pptx !== undefined, 'the report turn indexed the pptx')
  const token = pptx.split(/[\\/]/).pop()

  const ownerShape = {
    turn: { turn: 1, data: { get: () => undefined } },
    seq: 10,
    sessionId: 'session-1',
    openFile: () => {},
  }
  const closing = base.services.get('chatFileMentions').forClosing(ownerShape, 'session-1')
  const mention = closing.resolve(token)
  assert.ok(mention !== undefined, 'the pptx resolves as a mention')
  mention.open()
  assert.equal(opened.length, 1, 'the click reaches the sidebar')
  assert.match(opened[0], /^dsh-resource:\/\/file\/session\/session-1\//)
})

check('a click the sidebar refuses falls back instead of going silent', () => {
  // `openResource` throws whenever no session surface is mounted — the column is
  // not rendered at all — or when no tab type claims the address. Swallowing that
  // is what made 0.5.0's links indistinguishable from a click that never arrived.
  const fallbacks = []
  const base = fakeContext()
  base.services.set('sidebarRight', {
    openResource: () => {
      throw new Error('sidebarRight: no session surface is mounted')
    },
  })
  base.services.set('chatFileMentions', { forClosing: () => undefined })
  const { ctx } = guardedContext(base, DECLARED)
  exportsOf.apply(ctx)
  const { data } = fold(base, reportTurn())
  const pptx = data.value.artifacts.find((path) => path.endsWith('.pptx'))
  const token = pptx.split(/[\\/]/).pop()

  const ownerShape = {
    turn: { turn: 1, data: { get: () => undefined } },
    seq: 10,
    sessionId: 'session-1',
    openFile: (path) => {
      fallbacks.push(path)
    },
  }
  const closing = base.services.get('chatFileMentions').forClosing(ownerShape, 'session-1')
  const mention = closing.resolve(token)
  assert.ok(mention !== undefined, 'the pptx resolves as a mention')
  mention.open()
  assert.equal(fallbacks.length, 1, 'the chat view opener takes over')
  assert.match(fallbacks[0], /v13\.pptx$/, 'with resolved absolute path')
})

/**
 * Capture what the plugin reports, rather than letting it scroll past.
 *
 * The plugin warns once per broken thing instead of failing silently, which is the
 * whole point of `reportOnce` — a click that goes nowhere must leave a trace. Here
 * the trace is an assertion: every message distinct, so the dedup contract holds.
 */
const warnings = []
console.warn = (...args) => {
  warnings.push(args.map((value) => String(value)).join(' '))
}

check('the file menu reaches the Host through the same guard', async () => {
  // The menu's two items run on the real context — `inject: () => ({ ctx })` — so
  // they hit the same Proxy the mention opener did. Both must reach the remote
  // rather than throwing on the way there.
  const calls = []
  const base = fakeContext()
  base.remote.session.openWorkspacePath = async (request) => {
    calls.push(request)
    return { ok: true, value: { opened: true } }
  }
  const { ctx } = guardedContext(base, DECLARED)

  const address = exportsOf.sessionFileAddress('session-1', 'reports/report 2026.pptx')
  const node = exportsOf.FileTabMenuItems({ tab: { contentId: address }, dismiss: () => {}, ctx })
  const buttons = (node.children || []).filter((child) => child !== null && child.props?.onClick !== undefined)
  assert.equal(buttons.length, 2, 'both actions are offered for a file tab')
  for (const button of buttons) button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(calls.length, 2, 'both actions reached the Host')
  // The RPC carries no session, so the browser has to hand it something absolute:
  // a workspace-relative path would be resolved against the `dsh web` process's
  // working directory on the far side, which is a different file or none at all.
  const workspace = fakeContext().sessions.list.getSnapshot().byId['session-1'].cwd
  assert.deepEqual(calls[0], { path: `${workspace}/reports/report 2026.pptx` }, 'the open action sends a resolved path')
  assert.deepEqual(calls[1], { path: `${workspace}/reports` }, 'the reveal action sends the containing folder')
})

check('a reveal Explorer cannot perform opens the folder instead', async () => {
  // The Host's reveal is unusable on two measured counts: `explorer.exe /select,
  // <percent-encoded file URL>` finds nothing when the name needs a multi-byte
  // escape (`暑期科研汇报_v13.pptx`, `中文目录\report.pptx` produced no window at
  // all, while `plain.txt` and `with space.txt` did), and even when it does open
  // the folder the window stays behind the browser — a reader reported "nothing
  // happens" while the same folder was found open six times over. So the reveal
  // item asks for the containing folder, which the Host opens with PowerShell's
  // `Invoke-Item -LiteralPath` and which works for every name.
  const calls = []
  const base = fakeContext()
  base.remote.session.openWorkspacePath = async (request) => {
    calls.push(request)
    return { ok: true, value: { opened: true } }
  }
  const { ctx } = guardedContext(base, DECLARED)
  const workspace = base.sessions.list.getSnapshot().byId['session-1'].cwd

  const render = (path) => exportsOf.FileTabMenuItems({
    tab: { contentId: exportsOf.sessionFileAddress('session-1', path) },
    dismiss: () => {},
    ctx,
  })
  const revealOf = (node) => (node.children || []).find((child) => child?.props?.['data-file-tab-action'] === 'reveal')

  revealOf(render('reports/暑期科研汇报_v13.pptx')).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(calls.at(-1), { path: `${workspace}/reports` }, 'a non-ASCII name opens its folder')

  revealOf(render('reports/plain.txt')).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(calls.at(-1), { path: `${workspace}/reports` }, 'and so does an ASCII one, instead of a reveal nobody sees')

  // The nested-directory case is why the rule cannot be "is the file name ASCII?":
  // here the *directory* carries the multi-byte escape.
  revealOf(render('reports/中文目录/plain.txt')).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(calls.at(-1), { path: `${workspace}/reports/中文目录` }, 'a non-ASCII directory opens its folder too')
})

check('the folder cut is what the measurement says', () => {
  assert.equal(exportsOf.parentFolderOf('C:/a/b/c.txt'), 'C:/a/b', 'the folder above a file')
  assert.equal(exportsOf.parentFolderOf('C:/a/b/'), 'C:/a', 'a trailing separator is not a name')
  assert.equal(exportsOf.parentFolderOf('C:/a'), 'C:/', 'a drive root keeps its separator')
  assert.equal(exportsOf.parentFolderOf('/a'), '/', 'so does a POSIX root')
  assert.equal(exportsOf.parentFolderOf('b.txt'), undefined, 'a bare name has no folder to name')
})

check('a path the Host says is gone is reported, not opened', async () => {
  // The native opener cannot report a reveal's failure: the Host swallows
  // Explorer's exit code 1, which is what Explorer returns for a path it cannot
  // select. Measured, `revealNativePath` on a nonexistent path resolves in 510 ms
  // and shows nothing — so "gone" and "opened" reach the plugin as one success.
  // `workspaceFiles.stat` is the authority that separates them, and this is the
  // check that it is consulted before anything is claimed.
  stateUpdates.length = 0
  const calls = []
  const base = fakeContext()
  base.remote.session.openWorkspacePath = async (request) => {
    calls.push(request)
    return { ok: true, value: { opened: true } }
  }
  base.remote.workspaceFiles = {
    stat: async () => ({ ok: false, error: { message: 'no entry at "assets/_v13_overview.png"' } }),
  }
  const { ctx } = guardedContext(base, DECLARED)

  const node = exportsOf.FileTabMenuItems({
    tab: { contentId: exportsOf.sessionFileAddress('session-1', 'assets/_v13_overview.png') },
    dismiss: () => {},
    ctx,
  })
  const reveal = (node.children || []).find((child) => child?.props?.['data-file-tab-action'] === 'reveal')
  reveal.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(calls.length, 0, 'nothing is handed to the opener')
  const said = stateUpdates.filter((value) => typeof value === 'string')
  assert.match(String(said.at(-1)), /文件不存在/, 'the reader is told the file is gone')
  assert.match(String(said.at(-1)), /_v13_overview\.png/, 'and which path was tried')
})

check('the Host resolves the path, and its answer is what gets opened', async () => {
  // `stat` resolves a relative path against the addressed Session's workspace root
  // — the same root the Sidebar's resource loader uses — and it allows absolute
  // paths outside that workspace, which is where these artifacts usually live.
  stateUpdates.length = 0
  const asked = []
  const calls = []
  const base = fakeContext()
  base.remote.session.openWorkspacePath = async (request) => {
    calls.push(request)
    return { ok: true, value: { opened: true } }
  }
  base.remote.workspaceFiles = {
    stat: async (sessionId, path) => {
      asked.push([sessionId, path])
      return { ok: true, value: { absolutePath: 'C:/real/place/报告_v13.pptx' } }
    },
  }
  const { ctx } = guardedContext(base, DECLARED)

  const node = exportsOf.FileTabMenuItems({
    tab: { contentId: exportsOf.sessionFileAddress('session-1', 'reports/报告_v13.pptx') },
    dismiss: () => {},
    ctx,
  })
  const reveal = (node.children || []).find((child) => child?.props?.['data-file-tab-action'] === 'reveal')
  reveal.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.deepEqual(asked, [['session-1', 'reports/报告_v13.pptx']], 'the Host is asked about the tab path')
  // The Host's own answer beats the browser's guess, and the non-ASCII name takes
  // the folder route for the reason measured in the reveal check above.
  assert.deepEqual(calls, [{ path: 'C:/real/place' }], 'the opener gets the Host-resolved folder')
  assert.equal(stateUpdates.at(-1), '已打开所在文件夹', 'and the status line says what happened')
})

check('an unverifiable path still opens, rather than being refused', async () => {
  // An older Host has no `workspaceFiles` on the remote, and a transport
  // mid-reconnect answers nothing. Verification is an improvement, not a new
  // precondition: without it the plugin behaves exactly as it did before.
  const calls = []
  const base = fakeContext()
  base.remote.session.openWorkspacePath = async (request) => {
    calls.push(request)
    return { ok: true, value: { opened: true } }
  }
  const { ctx } = guardedContext(base, DECLARED)
  const node = exportsOf.FileTabMenuItems({
    tab: { contentId: exportsOf.sessionFileAddress('session-1', 'reports/plain.txt') },
    dismiss: () => {},
    ctx,
  })
  const reveal = (node.children || []).find((child) => child?.props?.['data-file-tab-action'] === 'reveal')
  reveal.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls.length, 1, 'the action still reaches the Host')
  assert.equal(calls[0].path, `${fakeContext().sessions.list.getSnapshot().byId['session-1'].cwd}/reports`, 'as its folder route')
})

let failed = 0
for (const { name, fn } of checks) {
  opened.length = 0
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (warnings.length > 0) {
  const unique = new Set(warnings)
  if (unique.size !== warnings.length) {
    failed += 1
    console.log(`FAIL the plugin reports each broken thing once`)
    console.log(`     ${String(warnings.length)} reports, ${String(unique.size)} distinct`)
  } else {
    console.log(`ok   the plugin reports each broken thing once (${String(warnings.length)} distinct)`)
  }
}

console.log(`\n${String(checks.length + (warnings.length > 0 ? 1 : 0) - failed)}/${String(checks.length + (warnings.length > 0 ? 1 : 0))} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
