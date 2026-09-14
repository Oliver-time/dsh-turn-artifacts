# dsh-turn-artifacts

> DeepSeek Harness Web GUI 插件：让「脚本产出的文件」在收尾回复里也能点开；顺带把会话历史窗口一次填满。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English summary** — [jump to the English section](#english)

## 它解决什么问题

收尾回复里写成 Markdown 行内代码的文件名，在 Web GUI 里会变成可点击的链接。这份词表来自 `@deepseek-ai/dsh-client-ui-deliverables`，而它只统计**成功的第一方修改调用**（`write`、`edit`、有修改作用的 `str_replace_editor`）的参数。后果是：

| 你写的 | 实际来源 | 结果 |
| --- | --- | --- |
| `版式打磨说明_v13.md` | `write` 工具创建 | 可点 |
| `暑期科研汇报_v13.pptx` | python-pptx 脚本生成 | **点不开**，写成什么样都不行 |
| `assets\polish_v13.py` | `write` 创建过，但写成带目录前缀的形式 | **点不开**，词表只认完整路径或纯文件名 |

第二行才是痛点：一次汇报的主角是那个 pptx，而它恰好是唯一一个必须用脚本生成的二进制文件。

本插件补上缺的那一半，而不是改那一个。它记下**本轮工具调用与工具结果里出现过的产物路径**，作为第二个 mention 解析器接在官方后面。官方词表仍然优先回答，所以原本能点的链接行为一字不变；本插件只接管官方会留成死代码的那些 token。

## 功能

1. **脚本产物可点**（插件的主职）。收尾正文里用行内代码提到本轮产出过的文件，就能点开，即使它只被脚本碰过。
2. **多一行「脚本产物」**。收尾消息末尾列出行内不可见、但本轮确实产出的文件 chip，点击直接打开。只列文件工具没写过、纯由命令产出的那些，不与官方那行重复。
3. ~~**历史窗口自动填满**~~ —— **默认关闭**，原因见下。

### 修过的问题（v0.4.0）

#### 一、对话区空白 —— 真正的根因是崩溃，不是历史填充

曾经有一段时间，某些对话点进去**对话区是空的**，而同样的对话以前能正常打开。现象是：出问题的会话日志 **1.6 MB – 5.4 MB**，正常打开的只有 20 KB 上下，差了**两个数量级**，所以一开始大家都怀疑是历史填充（它在会话打开时会把窗口补到日志开头，上限 60 页 = 3000 条消息）。

**那个怀疑是错的。** 真正的根因在产物定义里：

```js
// 一个会话的已加载窗口可以从「某个 turn 的中间」开始 ——
// 本该播种这个 state 的 turn/start 落在这一页之外。
// 于是 update 与 buildLocationData 会在 state 仍为 undefined 时被调用。
const turn = context.state.turn;   // ← TypeError: Cannot read properties of undefined
```

这个异常会**打断会话事件流**，结果是整个对话区渲染为空。大日志之所以容易中招，只是因为窗口**更可能落在 turn 中间** —— 跟填充拉了多少页无关。

修法是在两处加防御（`lib/client.js` 的 `artifactDefinition`）：`update` 在没有 phase 时直接返回，`buildLocationData` 从 context location 兜底取 turn 号，取不到就**不发布**（而不是猜一个会被装配器拒绝的值）。

回归测试：`test/harness.mjs` 里有一项专门喂「update 先于 start 到达」的上下文；`test/regression-probe.mjs` 更进一步 —— 它把守卫那一行剥掉再跑，**验证这个测试真的会失败**（当前输出：`threw: Cannot read properties of undefined (reading 'turn')`）。抓不住 bug 的回归测试不算回归测试。

#### 二、历史自动填充默认关闭

修了上面的崩溃之后，历史填充本身已经没有已知问题（它只是调用核心的 `loadOlder()`，和读者点分页按钮是同一条路）。但它仍然**默认关闭**，因为：

- 它一次会话打开就要拉最多 60 页、把几千条事件灌进客户端，代价和收益不成比例；
- 在根因未明之前它是被怀疑的对象，保持关闭是最保守的选择。

开关在 `lib/client.js`：

```js
const HISTORY_AUTOFILL_ENABLED = false;   // 翻成 true 即恢复
```

**插件的主职（脚本产物可点）完全不依赖这段代码** —— 关掉只损失「一打开就是完整历史」，代价是长对话要用视图自带的「加载更早」按钮一页页翻。

真正的修法不是「拉得更快」，而是**跟着滚动懒加载**（读者往上滑才取下一页）。这一版没做。

#### 三、同一个症状的另一个已知来源

排查期间还观察到：旧的 session 日志里可能存在**重复的 instruction-hint message id**，它同样会让对话区渲染异常。本插件与它无关（那是日志数据层面的问题），但如果你的空白现象在本插件修好之后仍出现，**先怀疑这个**。

## 安装

插件以**普通包**的形式挂在某个 profile 下，不需要改 DSH 源码。

```bash
# 1) 装进 web profile（dsh plugin 的参数会转发给 profile 目录里的 pnpm）
dsh plugin --profile web add github:Oliver-time/dsh-turn-artifacts
```

```jsonc
// 2) 把包名加进 ~/.dsh/profiles/web/package.json 的 bundle 列表
"dsh": { "profile": { "bundles": [ "…", "dsh-turn-artifacts" ] } }
```

```bash
# 3) 重启
dsh web
```

第 2 步是关键：`dsh.bundle.patch` 只有在包被列为 profile bundle 时才会被读（`dsh-app-boot` 的 `loadProfile` 按 `dsh.profile.bundles` 顺序解析每个包的 `dsh.bundle`）。列进去之后，本包自带的 `cordis.patch.yml` 会自动把 Loader 行插进插件树 —— **不需要你手写任何路径**，这是给使用者准备的安装方式。

装完可以这样确认两半都活着：

```bash
curl -s "http://127.0.0.1:3080/?token=<页面里的 token>" | grep -c dsh-turn-artifacts/client.js
# 输出 ≥1：客户端 bundle 已经被组合进启动清单
```

<details>
<summary>从本地目录开发（没有安装包时）</summary>

包还没有被 pnpm 装进 profile 时，Loader 行必须直接指到文件，并写成 `file://` URL：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: turn-artifacts
      name: file:///C:/path/to/dsh-turn-artifacts/index.js
```

裸的 `C:\...` **不行**：ESM Loader 只认带 scheme 的 URL，会以 `Received protocol 'c:'` 失败，而且这个失败会让整个 profile 起不来。

这时**不要**同时把包名写进 `dsh.profile.bundles` —— 那样包自己的 patch 会再插一行同 id 的行，boot 会以 `duplicate loader entry id: turn-artifacts` 失败。二选一：本地路径行，或者已安装 + bundle 列表。

浏览器侧的模块 id 取自 `package.json` 的 `name`，与 Loader 行的 `id` 无关。
</details>

### 验证装好了

- 重启后网页里出现一行「脚本产物」，说明客户端半部活着。
- 让 agent 跑个产出文件的脚本，收尾里写成 `` `文件名.ext` ``，应该变蓝。
- 想看模型侧那段提示词是否注册：`dsh --profile web --dump-config`，插件树里应能看到这一行。

## 卸载

从 `dsh.profile.bundles` 里删掉包名并重启，或者在 profile 的 `cordis.patch.yml` 里把它覆盖成 `- id: turn-artifacts` + `disabled: true`。本插件不改动任何 core 文件，卸载即回到原状。

## 工作原理

### 证据（浏览器半部）

插件注册一个 turn 级 conversation Definition，跟随三类事件累积：

- `turn/start`：开一轮的累加桶。
- `tool/call`：取 `file_path` / `path` / `file` 参数，以及 `pwsh` / `bash` 的 `command` 里出现的路径；同时按官方同一套校验规则记下 mutation 路径（先记，等结果落地才算数）。
- `tool/result`：把结果文本里像产物的路径收进来。**失败的结果一律不贡献** —— 它描述的是「试过什么」，不是「产出了什么」。

这里有个容易踩的坑，值得单独说：真实事件里可读文本在**下一层**。

```
message.content[0] = { type: 'tool-result', toolCallId, isError, content: [{ type: 'text', text }] }
```

`ToolResultBlock.content` 才是装文本的数组（见 `@deepseek-ai/dsh-llm` 的 `ToolResultBlock`）。直接读 `block.text` 在真实事件上永远是空字符串 —— fixture 如果写成扁平形状，测试会全绿而线上一个路径都索引不到。`test/wire.mjs` 固定了这条线形，`test/probe.mjs` 用它做端到端探针。

### 路径识别规则

只收**已知产物扩展名**的 token，并且：

- 折叠 JSON 转义后的分隔符（工具输出到浏览器是转义拼写）；
- 丢掉紧贴路径的引号、逗号、括号，但**保留盘符的冒号**；
- 剔除 URL（`https://host/x.svg` 的末段和产物长得一模一样，只有 scheme 能区分）；
- 中文目录名照常识别。在汉字处截断会索引出**错误**路径，而点开错文件比点不开更糟。

一条硬规则：**不猜位置**。从结果文本里抽出来的路径必须自带位置（盘符 / 前导斜杠 / 至少一层目录）才进索引：

- `C:\...\v13.pptx` → 记下它自己说的位置。
- `assets/_v13_overview.png` → 有目录，按工作区相对路径记。
- `暑期科研汇报_v13.pptx`（纯文件名）→ **丢弃**。

纯文件名没有位置，把它拼到 session 工作区根上只是猜测，而这个猜测会造出坏链接：指向不存在的文件，或指向另一个目录里的同名文件。工具调用的 `file_path` / `path` / `file` 参数是例外 —— 那次调用自己点明了文件，不算猜。

### 解析与优先级

匹配顺序：完整路径精确命中 → 后缀命中 / 唯一 basename。**绝对路径优先于相对路径**，同级之间取较短拼写；没有证据的 token 保持惰性。绝对路径优先是因为它记录的是文件真实所在，而相对路径还要再经过工作区拼接 —— 那一步正是链接指向错误目录的来源。

### 怎么接进聊天视图

官方 provider 由注册持有 `chatFileMentions` 服务，别的 fiber 既不能重复 `provide` 也不能 `set`。它能被扩展的地方就是**这个对象本身**，所以插件包裹 `forClosing` 一个方法：先问官方，官方不答再问自己。`connection/reset` 时重新包裹，`ctx.effect` 负责还原。

### 让 agent 愿意写成链接（Host 半部）

插件只能**读**提及。收尾正文里没有那个文件名，就没有链接可点。

核心已经注册过一段系统提示词（`ui:deliverable-file-references`，order 9000），要求把主要产出写成行内代码。但它写的是「成功创建或修改的文件」，脚本产出的二进制不在覆盖范围。本插件补一段自己的（`ui:turn-artifact-file-references`，order 9001）说明三件事：脚本产物同样算交付物、同样写成行内代码；**路径从没出现在任何工具输出里就不可能被链接**，所以打算交付的产物要让命令把路径打印出来；文件名不必写全路径，唯一 basename 也能匹配。

**为什么另起 section 名而不是替换核心那段**：prompt 注册表只允许**更深 scope** 用同名 section 覆盖全局（`ScopedLayers.merge`）；插件作为 Loader 行注册在全局层，同名会直接抛

```
prompt section "ui:deliverable-file-references" is already registered
(for a per-agent override, register through that agent's `agent.ctx`)
```

而这个错误会 abort 整个 profile boot。紧跟核心那段另起一段，是同样效果、且不会让服务起不来的做法。代价是每轮多约 80 tokens 固定文本，进可复用的 prompt 前缀，不随轮次变化。

### 历史填充的两处依赖

`fillHistory` 用的是 `sessions` 服务交出来的 Session 对象：

- `binding(id).session` 是文档化的路径；具体服务还额外暴露 `resolve(id)`。两个都试，文档化的优先，另一个作兜底。
- `session.open()` 是行为上公开、但不在 `ISession` 类型上的方法（首次拉页，已打开则空操作）。
- `hasMore` / `baseSeq` 是具体 `Session` 类上的字段，不在接口上；`loadOlder()` 才是公开动词。

这些字段都是防御式读取的：哪个被改名，最坏结果是「不填充」，而不是报错（`hasMore !== true` 会在第一次判断就结束循环）。

只有**真的填了页**的 session 才会被记为已处理。打不开、正在重连、id 还解析不到的会话会留待下一次选择变化重试；如果记的是「尝试过」，那个会话就会整个页面生命周期停在第一页。

## 与新版侧边栏的关系（0.1.5-rc.2 及以后）

DSH 从 0.1.5-rc.2 起带了一批侧边栏插件（`dsh-client-ui-sidebar`、`-files`、`-documentpreview`、`-right`），会自动回答「这个文件长什么样」。**它们不取代本插件**，两者解决的问题不同：

| | 右侧边栏 | 本插件 |
| --- | --- | --- |
| 入口 | 你自己在文件树里找，或点早已存在的链接 | 正文里的行内代码**自动**变可点 |
| 范围 | 整个工作区 | 本轮产物（有证据的那些） |
| 渲染能力 | **只能渲染 md / markdown、html / htm、pdf**，其余走纯文本 | 不渲染，交给系统打开器 —— **pptx、xlsx、png、mp4、zip 都能开** |
| 词表来源 | 不涉及 | 工具调用与结果里的路径（官方词表之外的那部分） |

决定性的一条是**渲染能力**：侧边栏预览注册的扩展名只有 `md`、`markdown`、`html`、`htm`、`pdf`（外加未知扩展名的纯文本兜底）。一个 python-pptx 生成的 `.pptx`、一张 matplotlib 的 `.png`、一段 ffmpeg 的 `.mp4`，侧边栏**都渲染不了**；本插件把这些交给系统打开器，用真正的 PowerPoint / 看图器 / 播放器打开。所以「脚本产出的二进制」这个场景，侧边栏帮不上忙。

真正被侧边栏改善的是**文本类产物**：`.md`、`.html`、`.pdf` 现在可以在侧边栏里读，不用弹到外部程序 —— 这一点本插件也乐意让位，它本来就不做渲染。

**副作用（已在 v0.4.1 修）**：新版把 `chatFileMentions.forClosing` 的签名从 `(owner)` 扩成了 `(owner, sessionId)`，用 `sessionId` 构造 `dsh-resource://` 地址好让文件在侧边栏里打开。本插件是**包裹**这个方法的，v0.4.0 及以前只转发 `owner`，于是官方解析器拿到 `undefined` 的 sessionId —— **包装动作反而把官方功能弄坏了**。v0.4.1 改为用 rest 参数转发全部实参，与上游签名解耦；`test/harness.mjs` 里有一项专门盯着这个转发。

## 已知限制

- **只作用于「本轮」收尾消息。** 索引随 turn 累积，但换一个话题后，旧轮的行内代码不会因为本轮出现同名文件而变可点。
- **依赖工具输出里出现过路径。** 一条命令产出了文件却什么都没打印，插件无从得知。Host 半部的提示词要求它打印，但那是引导不是保证。
- **提示词是引导，不是强制。** agent 仍可能只写文件名（现在没问题，词表更宽了），也可能干脆不提（这个无解）。
- **工作区相对路径按当前 session 工作区拼接。** 只有在工具自己打印了相对路径时才会这样，此时它本来就是相对工作区说的；换个 session 打开旧轮次时，工作区根可能已经不是当初那个，链接就会落空。
- **点击时不做存在性校验。** 可能存在假阳性（例如某次读取的文件被当成产物），这时 Host 会报打开失败，而不是静默打开别的文件。
- **历史自动填充默认关闭**（成本考虑，不是它有 bug）—— 见上文专节。想开请在 lib/client.js 里翻开关。
- **客户端 bundle 与 Host 半部的加载时机不同。** Host 半部只在 `dsh web` 启动时加载，改了它必须重启；客户端 bundle 每次页面加载都从磁盘现读，改它刷新即可。

## 版本记录

- **v0.4.0** — 修掉「对话区空白」的真根因：产物定义在 `state` 未播种时崩溃（窗口从 turn 中间开始时发生），打断了会话事件流，导致整个对话区渲染为空。新增两项回归测试，其中 `test/regression-probe.mjs` 会剥离守卫来证明测试本身有效。历史填充改为默认关闭（成本考虑，不是它有缺陷）。
- **历史自动填充默认关闭**（成本考虑，不是它引起过空白 —— 那个 bug 在 v0.4.0 已修）。要开请在 `lib/client.js` 里翻 `HISTORY_AUTOFILL_ENABLED`。
- **v0.3.0** — 首次公开：脚本产物可点 + 产物 chip + Host 侧提示词。

## 故障排查

**某个文件没变蓝？** 按顺序查：

1. 那一轮的**工具结果**里有没有出现过这个路径（带位置的那种）。没有 → 任何插件都链接不了它；让产出它的命令打印路径。
2. 收尾正文里有没有把它写成行内代码。没有 → agent 没提，插件无从下手。
3. 鼠标悬停看 `title`：它显示**实际传给 Host 打开器的路径**，相对定位的会额外标注「相对工作区定位」。title 里的路径不对，说明索引到了别的证据。
4. 点开报 `无法打开文件` / `PathNotFound`：说明路径拼出来了但文件不在。多半是上面「工作区相对路径」那条限制。

**重启后服务起不来？** 看报错里有没有 `prompt section ... is already registered` 或 `Received protocol 'c:'` —— 前者是有人用了核心的 section 名，后者是 Loader 行写了裸盘符路径。两条都会 abort 整个 boot。

## 自测

```bash
npm test                      # 等于下面两条
node test/host.mjs            #  5 项：Host 半部的 section 名字/顺序/内容、status 服务、版本一致
node test/harness.mjs         # 19 项：客户端 bundle 的契约、证据规则、匹配优先级、autofill
```

诊断脚本（开发用，会读本机 session 日志）：

```bash
node test/probe.mjs      # 人眼抽样：真实 JSON / 真实线形 → 抽出的路径
node test/realdata.mjs   # 拿本机 session 日志里的真实工具结果跑抽取
node test/diagnose.mjs   # 按轮次列出真实 session 会索引到哪些路径、哪些调用
```

`test/harness.mjs` 自带一个 `window.__ModuleLoader__` 接收器、一张只含 `react` 的模块表和一个假 ctx，所以能在没有浏览器、没有 dsh 服务的情况下跑客户端 bundle 本身 —— 包括那个真实线形的嵌套结果块。

## 目录

```
index.js              Host 半部：Loader 行入口 + 那段提示词 + status 服务
lib/client.js         客户端半部：证据索引、链接解析、产物 chip、历史填充
cordis.patch.yml      本包作为 bundle 层时插入的 Loader 行
LICENSE               MIT
test/                 自测与诊断脚本
```

关于 `package.json` 的两点：`private: true` 是刻意的，防止误发 npm；要发布成官网包再去掉它，并按你的仓库补上 `repository`、`homepage`、`bugs` 三个字段。`lib/client.js` 里导出的一串函数是**测试缝**，不是 API（文件末尾有说明）—— 运行中的 GUI 只读 `apply` 和 `inject`。

## 许可

[MIT](LICENSE)

---

<a id="english"></a>
## English

**What it does.** In the DeepSeek Harness Web GUI, a file name written as Markdown inline code becomes a clickable link — but the shipped vocabulary comes only from successful `write` / `edit` / mutating `str_replace_editor` calls. A file that only a terminal command produced (a `.pptx` from python-pptx, a `.png` chart, an `.mp4` render) can never be linked, no matter how it is spelled. This plugin supplies that missing vocabulary instead of patching the shipped one: it indexes the paths that appeared in the current turn's tool calls and tool results and appends a second resolver to the `chatFileMentions` service, so the shipped vocabulary stays authoritative and only inert tokens get answered. It also adds a "script artifacts" row at the end of a turn, and — unrelatedly — fills a session's history window on open.

**Install.**

```bash
dsh plugin --profile web add github:Oliver-time/dsh-turn-artifacts
```

Then add `"dsh-turn-artifacts"` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json` and restart `dsh web`. Listing the package as a profile bundle is what makes its own `cordis.patch.yml` bundle layer apply, which inserts the Loader row — no absolute path to edit by hand. Developing from an uninstalled checkout instead? Point the Loader row at the file with a `file://` URL (a bare Windows path is rejected with `Received protocol 'c:'`, which aborts the boot) and do **not** also add the package to the bundle list, or the two rows collide as a duplicate id.

**Evidence rules.** A path is only indexed when it carries a location: an absolute path, or a path with at least one directory. A bare file name found in tool output is dropped, because joining it to the session workspace would be a guess that produces links to files which do not exist, or to same-named files elsewhere. Tool arguments (`file_path`, `path`, `file`) are the exception: that call named the file itself. Failed tool results contribute nothing. URLs and unknown extensions are rejected; JSON-escaped separators are folded; Chinese directory names are kept intact.

**Resolution.** Exact path first, then suffix or unique basename, with absolute candidates preferred over relative ones (an absolute path records where the file actually is). A link's `title` shows the path that will be handed to the Host opener.

**Model guidance.** The Host half adds one system-prompt section immediately after the shipped `ui:deliverable-file-references` one, telling the agent that script-produced files are deliverables too, that a file whose path never appeared in tool output cannot be linked, and that a unique basename is enough. It uses a distinct section name because a Loader row registers globally, where a duplicate name is a hard error that aborts the whole profile boot.

**Limits.** Per-turn only; a path must have appeared in tool output; the guidance is an instruction, not a guarantee; workspace-relative paths resolve against the current session workspace; no existence check at click time.

**Tests.** `npm test` runs the Host half (`test/host.mjs`, 5 checks) and the client bundle (`test/harness.mjs`, 19 checks) with no browser and no running harness. `test/probe.mjs`, `test/realdata.mjs`, and `test/diagnose.mjs` are development diagnostics over real session logs.

MIT licensed.
