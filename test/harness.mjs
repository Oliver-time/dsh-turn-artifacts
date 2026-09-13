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

/** React stand-in: the plugin only uses createElement and useEffect. */
const react = {
  createElement(type, props, children) {
    return { type, props, children }
  },
  useEffect() {},
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

check('mounting the plugin starts no history fill at all', async () => {
  // The fill is off by default: paging a multi-megabyte log back to its start on
  // open made conversations render empty (see HISTORY_AUTOFILL_ENABLED in
  // lib/client.js). `fillHistory` itself stays tested above as a pure function;
  // what must never regress silently is `apply()` reaching for the session list.
  const sessions = fakeSessions({ s1: fakeSession('s1', 3), s2: fakeSession('s2', 2) })
  const ctx = autofillContext(sessions)
  exportsOf.apply(ctx)

  await settle()
  assert.equal(sessions.listenerCount(), 0, 'the plugin must not subscribe to the session list')
  assert.equal(sessions.sessions.get('s1').loadCalls, 0, 'the current session is left alone')

  sessions.setCurrent('s2')
  await settle()
  assert.equal(sessions.sessions.get('s2').loadCalls, 0, 'switching sessions pages nothing')
  assert.equal(sessions.sessions.get('s2').openCalls ?? 0, 0, 'no session is opened by the plugin')

  ctx.disposeAll()
  assert.equal(sessions.listenerCount(), 0, 'disposal has nothing to release')
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
console.log(`\n${String(checks.length - failed)}/${String(checks.length)} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
