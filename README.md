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
3. **侧边栏文件标签的右键菜单多两项**（v0.5.0）：在侧边栏里打开文件后，右键标签上的文件名，除了侧边栏自带的「关闭」，还有 **用默认软件打开** 和 **打开文件所在路径**。
4. **打开会话不再卡**（v0.5.1）：历史填充改成带停顿、有预算、单飞，链接点击也从「静默失败」改成「失败会兜底、会留日志」。详见 [修过的问题（v0.5.1）](#修过的问题v051蓝字点不动--整个-dsh-变卡)。

### 右键菜单这两项怎么实现的

侧边栏（`@deepseek-ai/dsh-client-ui-sidebar-right`）为「标签动作菜单的额外项」留了一个 list 插槽 `sidebar.right.tab.menu.item`，菜单本体由 dockkit 渲染，自带一项「关闭」（宿主传入 `onClose`），插槽里的项作为 `extras` 追加在后面 —— 所以最终是**三项**。

插件注册两项，都通过客户端可用的远程方法落到 Host：

| 菜单项 | 调用 |
| --- | --- |
| 用默认软件打开 | `ctx.remote.session.openWorkspacePath({ path })` |
| 打开文件所在路径 | `ctx.remote.session.openWorkspacePath({ path, action: 'reveal' })` |

文件路径从**标签地址**反解：文件标签的 `contentId` 就是 `dsh-resource://file/session/<sessionId>/<path>`，插件自己解析（`parseFileAddress`），不依赖任何注册表。非文件标签（指南页等）解析返回 `undefined`，两项就不显示 —— 不会给你一堆点不动的选项。动作失败会在菜单里回一行可见提示，而不是静默。

### 点击链接一律先进侧边栏

0.1.5 起核心把 `openFile` 换成了侧边栏路由，但**官方词表里 `present` 工具声明过的文件仍然直接调原生打开器**（弹 PowerPoint）。本插件对自己的解析器采取**优先级而非兜底**：凡是插件索引到的路径，先由插件回答，统一走 `dsh-resource://file/…` 进侧边栏；其余 token 仍由官方解析器决定。这样「所有文件都先进侧边栏」才成立，之后在侧边栏里再用右键菜单决定要不要交给外部程序。

### 修过的问题（v0.5.1）：蓝字点不动 + 整个 DSH 变卡

v0.5.0 发出去之后，实际使用报回来两个症状：**链接是蓝的、点了没反应**，以及**整个 DSH 非常卡**。两个都复现了，根因不同，都修在 0.5.1。

#### 一、点了没反应：`ctx.sidebarRight` 不是 `undefined`，是**抛异常**

客户端 Context 是一个 Proxy：**读一个没有在 `inject` 里声明过的服务名，会在「读属性」这一刻直接抛** `cannot get property "X" without inject`。抛出点在求值属性本身，所以 `?.`、`??`、以及调用方自己写的 `try` 都救不了 —— 表达式还没走完就已经抛出去了。

v0.5.0 的 `sidebarOpener` 是这么写的：

```js
const sidebar = ctx.sidebarRight;   // ← 抛在这里，不是返回 undefined
```

于是**每一次点击都在 `sidebarOpener` 里炸掉**，`onClick` 当场中断 —— 表现就是「蓝字，但点了没反应」。真机页面上抓到的原始异常：

```
Uncaught Error: cannot get property "sidebarRight" without inject
    at sidebarOpener (…/dsh-turn-artifacts/lib/client.js)
```

修法是改用 `ctx.get('sidebarRight')`：这是 cordis 给「可能存在、也可能不存在」的服务准备的正规入口（本插件本来就用它读 `chatFileMentions`）。**不能**把 `sidebarRight` 写进 `inject`：那样在没有右侧边栏的部署（更老的 DSH、headless profile）上，整个插件都会去等这个永远不会出现的服务，等于把主功能（链接）一起赔进去。

同一个坑还有第二处：`ctx.off?.(...)`。客户端 Context 上没有 `off`，读它同样抛 —— 后果是**每次连接重置**时包裹器的回滚都会抛（控制台里的 `[connection] connection sink threw: Error: cannot get property "off" without inject`），而回滚后面的「重新安装包裹器」永远执行不到。现在改成调用 `ctx.on()` 返回的 disposer。

回归测试：`test/harness.mjs` 里的 `guardedContext()` 按真实 Proxy 的语义包住 fake ctx —— 读未声明属性就抛 —— 然后断言：读 `ctx.sidebarRight` 会抛、`ctx.get('sidebarRight')` 拿得到、提及点击能进侧边栏、边栏拒绝时有兜底、右键菜单两项能到达 Host。**没有这层 fake，这类 bug 在离线测试里永远是绿的**，因为普通对象读不存在的属性只会给 `undefined`。

#### 二、非常卡：历史填充按住主线程不松手

v0.5.0 的填充是**不喘气**地连续拉页：`while (pages < 60) await session.loadOlder()`。每拉一页都要把整段对话重新投影、重新渲染，所以开销随日志长度平方增长，页面 DOM 也跟着一起涨，而且涨上去就不再下来。

真机实测（同一个 1006 步的真实会话，Chrome + CDP，`PerformanceObserver` 统计 longtask）：

| 配置 | 结束后 DOM 节点 | 每 2.5 秒窗口的主线程阻塞 |
| --- | --- | --- |
| 不装插件 | 2 254 | 238 ms（仅首屏），之后 **0** |
| v0.5.0 | 34 586 | 2 263 / 2 310 / 2 037 ms，持续约 7 秒 |
| v0.5.1 | 13 482 | 659 / 674 / 282 / 236 / 317 ms，随后 **0** |

也就是说 v0.5.0 在填充的那几秒里，**每 2.5 秒有 2.2 秒占着主线程** —— 这时候点什么都没反应，跟第一个 bug 叠加在一起，就成了「又卡又点不动」。

v0.5.1 给填充上了三道刹车（常量都在 `lib/client.js` 顶部，可自行调）：

| 刹车 | 作用 |
| --- | --- |
| `FILL_PAGE_PAUSE_MS = 250` + `FILL_BACKOFF = 3` | 每页之间等一帧再加一段停顿；停顿按上一页的实测耗时成比例放大（上限 `FILL_MAX_PAUSE_MS = 4000`），页面越贵让得越多 |
| `FILL_NODE_BUDGET = 12000` | 页面 DOM 到这个量就停 —— 填充的产物是一个要开一整天的页面，**结束后的重量**比拉页速度更重要 |
| 单飞 + 换会话即放弃 | 一个会话只跑一次填充（v0.5.0 是「填完才记账」，于是填充期间的每一次列表通知都会再叠一次同样的填充）；读者切走后立刻停止给旧会话翻页 |

**提前停下不会永久丢链接**：历史是你往后翻时才加载的，而每加载一页都会把那一页的产物索引进词表，所以某一轮一旦出现在屏幕上，它的提及就是链接。预算放弃的只是「读者还没翻到的轮次提前变成链接」。真机验证（点「加载更早」逐页回翻）：节点 13 482 → 15 419 → 17 133 → 19 213，第 3 次点击后出现 7 个提及，点第一个即打开侧边栏并渲染出文件内容。

真正的解法还是那两个方向，**都还没做**：跟滚动懒加载，或者让索引彻底不依赖渲染窗口（索引是 per-turn 的，要做到这一点得改成整日志读取）。现在的取舍是「最近约一千条消息提前可用 + 其余随翻随有」对「打开即静默」。

#### 三、从「静默」改成「有痕迹」

上面两个 bug 有一个共同点：**它们都是静默的**。点不动的时候控制台什么都没有，因为 0.5.0 的 `sidebarOpener` 里写着 `catch {}`；填充把主线程按住的时候也没有任何提示，因为它「只是在工作」。

0.5.1 起，插件对**可降级**的失败会 `console.warn` 一次（每个名字只报一次，靠 `reportOnce` 去重）：边栏拒绝打开时、`openFile` 抛错时、连接重置回滚失败时。点不动仍然可能发生 —— 但下次它会留下一行日志，而不是让你只能靠猜。

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

#### 二、历史自动填充必须开着（曾经误关，导致老对话丢链接）

**这一节是本文档最重要的一节**，因为它记录了一个「修好一个 bug、弄坏另一个」的真实经过。

历史填充指的是：会话打开时，把窗口从默认的「最新 50 条」一页页补到日志开头。它一直是开着的，直到有人把某次「对话区空白」归因到它头上，于是 v0.4.x 把它关了。

**关掉之后的副作用，当时谁都没预料到：老对话里的文件链接全都不见了。**

原因是这个插件的证据来源：

```
客户端打开会话 → 只加载最新一页（50 条）
   ↓
产出文件的那个轮次（工具调用/结果）如果不在这一页里
   ↓
插件看不到证据 → 索引为空 → 收尾里的文件名只是普通行内代码 → 没有蓝字
```

实测数据：一个真实的长会话有 **8938 条事件 / 50 个轮次**，产出图片的轮次在第 1、7、12、18 轮 —— **全都在 50 条窗口之外**。所以关掉填充等于「所有超过一页的对话，历史链接全部失效」，而且**完全静默**：没有报错、插件看起来在跑、只是链接不存在。

真正的根因（第 1 节那个 `state` 崩溃）修好之后，填充重新开启并实测通过：真浏览器、50 轮会话、**743 个行内代码块正常渲染、33 个提及成功变成链接、零异常**。

开关在 `lib/client.js`，默认 `true`：

```js
const HISTORY_AUTOFILL_ENABLED = true;
```

**代价要说清楚**：打开一个会话最多会拉 60 页 × 50 条。对超大日志是实打实的开销 —— v0.5.0 就是因为不喘气地拉页而把主线程按住了几秒（实测数据见下面 v0.5.1 那一节）。v0.5.1 之后这条路径有了三道刹车：**页间停顿**（按上一页实测耗时成比例放大）、**DOM 预算**（`FILL_NODE_BUDGET`，到量即停）、**单飞 + 切走即放弃**。正确的解法还是那两个方向，**都还没做**：跟滚动懒加载，或者让索引不再依赖窗口（现在索引是 per-turn 的，要做到「不看窗口」得改成整日志读取）。`HISTORY_AUTOFILL_ENABLED` 仍是「历史链接能用」和「打开更省」之间的总开关。

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
- **历史自动填充必须开着**，否则超出第一页的历史链接会静默失效 —— 见上文专节。它可以用 `lib/client.js` 里的 `HISTORY_AUTOFILL_ENABLED` 关掉，但要接受那个代价。填充的另外三个常量（`FILL_PAGE_PAUSE_MS`、`FILL_BACKOFF`、`FILL_NODE_BUDGET`）控制它的**脾气**：停顿越长越不打扰，预算越大预热的滚动条越长。
- **超过 DOM 预算的历史不会「提前」变蓝。** 自动填充到量即停；再往前的提及要等你往后翻到那一页才会成为链接（翻页本身就会建立索引）。真机验证过这条路径。
- **客户端 bundle 与 Host 半部的加载时机不同。** Host 半部只在 `dsh web` 启动时加载，改了它必须重启；客户端 bundle 每次页面加载都从磁盘现读，改它刷新即可。**面板上已有的会话不受影响，要新开一轮或重开会话才看得到变化。**

## 版本记录

- **v0.5.1** — 修两个真机报回来的症状：**(1) 蓝字点不动** —— `ctx.sidebarRight` 在 cordis 的 Context Proxy 上不是 `undefined` 而是**抛异常**（未在 `inject` 声明的属性，读取即抛），点击死在 `sidebarOpener` 里；同类问题还有 `ctx.off?.(...)`，让每次连接重置的回滚都抛。两者都改用 `ctx.get(name)` / `ctx.on()` 返回的 disposer。**(2) 整个 DSH 很卡** —— 历史填充原来不喘气地连拉 60 页，实测填充期间每 2.5 秒有约 2.2 秒占着主线程；现在改成页间停顿（按实测耗时成比例退避）、`FILL_NODE_BUDGET` 预算封顶、单飞且切走即放弃（实测同窗口阻塞降到 0.2–0.7 秒，随后归零）。另外把「静默失败」改成「兜底 + 每个名字只 warn 一次」。测试从 24 项加到 32 项，新增 `guardedContext()`（按真实 Proxy 语义读未声明属性即抛）。
- **v0.5.0** — 侧边栏文件标签右键菜单加两项（用默认软件打开 / 打开文件所在路径），并把解析优先级反转，使所有被索引到的提及一律先进侧边栏，而不是弹外部程序。同时修掉包裹 `chatFileMentions` 依赖加载顺序的问题（服务晚注册时改为事件驱动补装，不再只依赖 apply 那一刻）。真机验证：在 Chrome 页面内调用菜单组件，两项渲染正确、两个动作分别发出 `{path}` 与 `{path, action:"reveal"}`。
- **v0.4.2** — 重新开启历史自动填充。v0.4.0/v0.4.1 关闭它是误判：那段时间「老对话里文件不再变蓝」正是关掉它造成的（证据在 50 条窗口之外，插件看不见）。当时归因的「对话空白」真因是 `state` 崩溃，已修。真浏览器实测：50 轮会话 743 个行内代码块正常渲染、33 个提及成链、零异常。
- **v0.4.0** — 修掉「对话区空白」的真根因：产物定义在 `state` 未播种时崩溃（窗口从 turn 中间开始时发生），打断了会话事件流，导致整个对话区渲染为空。新增 `test/regression-probe.mjs`，它会剥离守卫来证明回归测试本身有效。（同一版**错误地**关闭了历史填充，v0.4.2 已纠正。）
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
npm test                      # 等于下面三条
node test/host.mjs            #  5 项：Host 半部的 section 名字/顺序/内容、status 服务、版本一致
node test/harness.mjs         # 32 项：客户端 bundle 的契约、证据规则、匹配优先级、侧边栏地址、autofill 节奏、cordis Proxy 守卫
node test/autofill-off.mjs    #  3 项：历史填充必须在启动时接上（关掉它会让历史链接静默失效）
```

诊断脚本（开发用，会读本机 session 日志）：

```bash
node test/probe.mjs      # 人眼抽样：真实 JSON / 真实线形 → 抽出的路径
node test/realdata.mjs   # 拿本机 session 日志里的真实工具结果跑抽取
node test/diagnose.mjs   # 按轮次列出真实 session 会列出哪些路径、哪些调用
```

真浏览器验证（需要本机 Chrome，以及一个正在跑的 `dsh web`）：

```bash
node test/browser-menu.mjs "<带 token 的地址>"    # 在真实页面里调用右键菜单组件，打印菜单项与两个动作的实际远程调用
node test/browser-shot.mjs "<地址>" "<会话标题>" out.png   # 打开会话、截图、转储行内代码与提及数量
node test/live-mention.mjs "<地址>" "<会话标题>" [out.png]  # 打开会话、测填充的 longtask 与 DOM 重量、翻页直到出现提及、点第一个、报告侧边栏内容
node test/live-chip.mjs    "<地址>" "<会话标题>" [out.png]  # 同上，但点的是「脚本产物」那一行的 chip
node test/live-older.mjs   "<地址>" "<会话标题>"            # 单独检查「加载更早」控件本身（元素、坐标、点击后节点数）
node test/live-recon.mjs   "<地址>" [out.png]               # 只做侦察：首屏节点数、longtask 台账、页面全局对象、控制台
```

这几个脚本用 `test/cdp.mjs` 直接走 Chrome DevTools 协议（不需要装 puppeteer）。**这不是洁癖**：这个插件曾经在离线测试全绿的情况下把线上功能弄坏 —— 包裹时机依赖加载顺序、菜单没在真机点过、`ctx.sidebarRight` 在真机上抛异常而离线 fake 上返回 `undefined`。能点一遍就别只跑单测。

真机脚本要一个**带 token 的地址**（`dsh web` 启动时会打印）。想在不打扰正在用的那个服务的前提下测，可以复制一个 profile 做实验：把 `~/.dsh/profiles/web` 的 `package.json`、`cordis.yml`、`cordis.patch.yml` 拷到 `~/.dsh/profiles/webtest`，用目录联接（`mklink /J`）共享 `node_modules`，然后 `dsh --profile webtest --no-open --port 3081` —— 会话数据在 `$DSH_HOME` 下是共享的，所以实验对象就是真实会话。

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

**What it does.** In the DeepSeek Harness Web GUI, a file name written as Markdown inline code becomes a clickable link — but the shipped vocabulary comes only from successful `write` / `edit` / mutating `str_replace_editor` calls. A file that only a terminal command produced (a `.pptx` from python-pptx, a `.png` chart, an `.mp4` render) can never be linked, no matter how it is spelled. This plugin supplies that missing vocabulary instead of patching the shipped one: it indexes the paths that appeared in the current turn's tool calls and tool results and appends a second resolver to the `chatFileMentions` service, so the shipped vocabulary stays authoritative and only inert tokens get answered. It also adds a "script artifacts" row at the end of a turn, adds two native actions to the right Sidebar's file-tab menu, routes every link it answers into that Sidebar, and — unrelatedly — fills a session's history window on open.

**0.5.1 fixes two reported bugs.** *Dead links:* reading `ctx.sidebarRight` on a cordis client context does not return `undefined`, it **throws** (`cannot get property "sidebarRight" without inject`) because the service is not in this plugin's `inject` — and it throws on the property read, so `?.` and `try` in the caller are no help. Every click died inside `sidebarOpener`. `ctx.off?.(...)` had the same shape and made every connection reset throw out of the mention wrapper's rollback. Both now go through `ctx.get(name)` and the disposer `ctx.on()` returns. *Slowness:* the history fill used to pull up to 60 pages back to back — measured in a real browser, ~2.2 s of every 2.5 s window was a long task for about seven seconds, leaving a 34.6k-node page behind. It is now paced between pages (backing off in proportion to what the last page cost), capped by a DOM budget, single-flight, and abandoned when the reader switches sessions; the same measurement is now 0.2–0.7 s per window and then zero. Deferred history still links as you page back to it, because every page indexed feeds the vocabulary.

**Install.**

```bash
dsh plugin --profile web add github:Oliver-time/dsh-turn-artifacts
```

Then add `"dsh-turn-artifacts"` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json` and restart `dsh web`. Listing the package as a profile bundle is what makes its own `cordis.patch.yml` bundle layer apply, which inserts the Loader row — no absolute path to edit by hand. Developing from an uninstalled checkout instead? Point the Loader row at the file with a `file://` URL (a bare Windows path is rejected with `Received protocol 'c:'`, which aborts the boot) and do **not** also add the package to the bundle list, or the two rows collide as a duplicate id.

**Evidence rules.** A path is only indexed when it carries a location: an absolute path, or a path with at least one directory. A bare file name found in tool output is dropped, because joining it to the session workspace would be a guess that produces links to files which do not exist, or to same-named files elsewhere. Tool arguments (`file_path`, `path`, `file`) are the exception: that call named the file itself. Failed tool results contribute nothing. URLs and unknown extensions are rejected; JSON-escaped separators are folded; Chinese directory names are kept intact.

**Resolution.** Exact path first, then suffix or unique basename, with absolute candidates preferred over relative ones (an absolute path records where the file actually is). A link's `title` shows the path that will be handed to the Host opener.

**Model guidance.** The Host half adds one system-prompt section immediately after the shipped `ui:deliverable-file-references` one, telling the agent that script-produced files are deliverables too, that a file whose path never appeared in tool output cannot be linked, and that a unique basename is enough. It uses a distinct section name because a Loader row registers globally, where a duplicate name is a hard error that aborts the whole profile boot.

**Limits.** Per-turn only; a path must have appeared in tool output; the guidance is an instruction, not a guarantee; workspace-relative paths resolve against the current session workspace; no existence check at click time.

**Tests.** `npm test` runs the Host half (`test/host.mjs`, 5 checks), the autofill wiring (`test/autofill-off.mjs`, 3 checks) and the client bundle (`test/harness.mjs`, 32 checks) with no browser and no running harness. The harness wraps a fake context in `guardedContext()`, a Proxy that reproduces the real "cannot get property without inject" throw, because a plain fake object returns `undefined` and hides exactly the bug that shipped. `test/probe.mjs`, `test/realdata.mjs`, and `test/diagnose.mjs` are development diagnostics over real session logs; `test/live-*.mjs` drive a real Chrome against a running `dsh web`.

MIT licensed.
