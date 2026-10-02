# dsh 协议断代史（protocol-chronicle）

> 本文档是 dsh-compat 的考据底座：历代内核版本、变体谱系、协议面、实证破坏点、新协议预警。
> 所有结论带证据路径；"偏移"指官方桌面端 app.asar（未压缩）内字节偏移。
> 考据时间：2026-10-02，考据方式：本机取证 + npm registry + GitHub 官方/社区仓库。

## 0. 一句话结论

`ctx.tools/llm/webServer/agents/settings` 五大服务签名从 0.1.1-rc.2 到 0.2.0-rc.2 未变（稳定面可做薄）；
**最大单点破坏是 0.2.0 的 V4 producer-owned source kind**；0.2.0 起新增安装/启动两级 peerDependencies
强制 + `compatibility.json` 豁免；协议面实分四层，社区正在出现 ≥11 个新接口。

---

## 1. 内核版本时间线（npm `@deepseek-ai/dsh`，共 29 版，全部预发布）

| 版本 | 日期(UTC) | 里程碑 |
|---|---|---|
| 0.0.1-rc.1/2/5 | 08-10 ~ 08-12 | 0.0.x 系 |
| 0.1.0-rc.2/3/6 | 08-13 | 0.1.0 系开始 |
| 0.1.0-rc.7 | 08-17 | EAC v4.5-lite 起点内核 |
| 0.1.0-rc.8 | 08-19 | |
| 0.1.1-rc.1/2 | 08-21 | EAC v4.5-lite(8/24) 与 DSHEAC-AIO(1.1.0) 内核；npm CLI 现役 |
| 0.1.2-alpha.2~5 | 08-30 ~ 09-02 | 0.1.2 系（**alpha.1 未发 npm**，仅 EAC v5.3.6 内置） |
| 0.1.2-rc.1 | 09-03 | 与 EAC v5.3.6 同日 |
| 0.1.3-alpha.2 | 09-07 | 仅 alpha（EAC changelog 提过 0.1.3 settings API 变更） |
| 0.1.5-alpha.1/2 | 09-08 ~ 09-09 | **alpha.1 是 session V3 的 evidenceTag** |
| 0.1.5-rc.1/2 | 09-10 | 官方 Desktop Preview 与市场常见基线；EAC AIO v6.9.3-alpha.1 适配此线 |
| 0.1.6-alpha.1/2 | 09-15 / 09-17 | |
| 0.1.5-rc.3 | 09-22 | 回填补丁（晚于 0.1.6-alpha.2 发布） |
| 0.1.7-alpha.1/2, rc.1 | 09-22 ~ 09-23 | rc.1 是社区皮肤包常见最低要求 |
| 0.1.7-rc.2 | 09-24 | 官方 docs 有专门 upgrade-guide |
| 0.2.0-rc.1/2 | 09-28 / 09-29 | **V4 时代开始**；rc.2 与官方 Desktop v0.2 同日 |

dist-tags 怪癖：主包 latest=0.2.0-rc.2，但 dsh-base 等子包 latest 停在 0.0.1-rc.1——版本解析不能依赖 latest tag。

**Session 格式权威**（官方 docs/session-format-status.md）：`latestFinalizedVersion: 4`（已定稿），
`latestReleasedVersion: 3`（evidenceTag `dsh-v0.1.5-alpha.1`）；唯一权威是代码常量
`SESSION_FORMAT_VERSION`；alpha/beta/RC 同样建立格式义务。

---

## 2. 变体谱系（适配层的需求地图）

| 变体 | 内核关系 | 插件协议面增量 | 适配需求 | 实测 |
|---|---|---|---|---|
| **官方 CLI**（npm `@deepseek-ai/dsh`） | 同包自举 | 规范源：cordis patch 四层 + client inject + llm seam + dsh-sdk-app/ACP | 基准 | ✅ 本机 0.1.1-rc.2 |
| **官方 Desktop v0.2**（Electron, nightly） | 内置 0.2.0-rc.2 | 与 CLI 共享 `~/.dsh`；`%APPDATA%\@deepseek-ai\dsh-desktop` 为数据目录 | 基准（V4） | ✅ 本机 |
| **EAC v4.4.x**（Electron→portable） | 0.1.0-rc.7~0.1.1-rc.2 | `~/.dsh/extensions/` + registry.json 发现面；plugin-guard 静态扫描；supervisor crashStreak/quarantine | 中（发现面+守卫语义） | ✅ 本机（休眠） |
| **EAC v5.3.6**（Tauri 2） | 内置 **0.1.2-alpha.1**（未发 npm） | v4 全部 + Extension Host SDK V1（`ctx.log/registerTool/provideContext/on/settings` + deny-by-default 权限门 + Job Object 围栏）；`SettingsScopeController.load()` 已移除 | 高（SDK 面） | ⚠️ 同族 0.1.2-alpha.2~rc.1 近似 + L4 模拟 |
| **EAC v6.0.0-beta** | `file:vendor/kernel/*` 零改动（ADR 0002） | **window.dshDesktop protocolVersion 1**（plugins/updates/boot/windowControls + `_call/_send/_onNotify/_onReady`）；能力桩 `{ok:false, unavailable:true, capability, reason}`；stdio/WS JSON-RPC；ADR 0008 分发账本（builtin/recommended/external + `.sync/*.json` + `.dshpack`）；skin.json 皮肤协议 | 高（新协议，v0.2） | ❌ 未装 |
| **DSHEAC-AIO 1.1.0** | 钉版快照 0.1.1-rc.2 整包 | sidecar 程序化写 profile（agent-presets YAML 块 + patch disabled 行 + patch-row-heal）；12 内置插件全官方式 | 低-中（共处需让过 sidecar 写入） | ✅ 本机 |
| **dsh-tauri**（deepseek-harness-desktop） | 多内核下载进 `$AppData/dependencies/dsh`，托管 shim + PATH 注入 | **无协议增量**；自带 manifest.jsonc「插件版本↔内核版本」兼容矩阵（`{version, dsh}` 区间对数组） | 低（只读其矩阵） | ❌ 未装 |
| **desktop-cc-gui**（Tauri 多引擎客户端） | adopt-or-start 本地 dsh web host + headless profile | DSH 用官方面；自有 `@ccgui/plugin-sdk`（应用层，trust boundary），**无 dsh 插件翻译层** | 高（若要打通两个宇宙，v0.2+） | ❌ 未装 |
| **LaplaceYoung/oh-my-dsh** | 官方内核，cordis.yml 组合 | 官方 ctx.* 扩展缝 + 自整理 `docs/seams-reference.md`（约 530 插件） | 低（术语对齐源） | ❌ 未装 |
| **纯壳**（HaoyueQin、agent-earth） | 拉起官方 web UI | 零增量 | 无需 | ❌ 未装 |
| **@linxin666/dsh-desktop-launcher** | 是插件不是壳 | 官方面内活动（`dsh web` 一键启停） | 无需 | ❌ 未装 |

EAC 内部版本线补充：v4.5-lite(8/24, 内核 0.1.0-rc.7→0.1.1-rc.2, 换 Tauri)、v5.1.0(8/25, 适配 rc.2 内核六插件 shim)、v6.0.0-beta(9/27~28, ADR 0006 内核解耦)。

---

## 3. 四层协议面详解

### 3.1 静态层（cordis patch 组合）

- 组合顺序：`dsh.profile.bundles` 各 bundle patch 依序 → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖。
- 插件 manifest：`dsh.bundle.patch`（bundle 角色）+ `dsh.profile.bundles`（profile 角色）；`dsh.client.{inject,platform}` 是外部消费者 key。
- patch 条目：`id`（目标 id 定向）、`config` 覆盖、`disabled` 开关、insert 列表；`!!js` 表达式允许。
- 官方 patch.yml 会被桌面端设置同步重写（已知坑：内联 `[]` 开头会导致追加条目 YAML 解析失败）。

### 3.2 client inject（浏览器半）

- node 半扫描声明 `dsh.client` 的包 → 组装 `window.__DSH_BOOT__` entry graph → webserver serve `/plugins/<id>/client.js` → 浏览器半 `window.__ModuleLoader__.load({id, factory})` 执行。
- client 插件返回 `(ctx)=>{...}` 或 `{name, inject:[...], apply(ctx)}`；**`ctx.<service>` 按 inject 声明白名单**（未声明即抛错）；可注入座位：slots/theme/timer/sessions 等。
- slots 系统：SlotKind single/list/keyed/chain；未声明 slot 注册抛错、同 cell 同 priority 第二注册抛错；包元数据缓存永不过期（插件集变化需重启）。
- 0.1.1-rc.2 **没有独立 `@deepseek-ai/dsh-client-ui-slots` 包**（slot 契约内嵌于 dsh-cordis-client-runner）；0.1.2-alpha.1 起才有。
- 版本漂移防护 = fail-loud 结构校验，无版本握手。

### 3.3 ctx 服务面（0.1.1-rc.2 d.ts 为基线，签名至 0.2.0-rc.2 未变）

- `ctx.tools`（dsh-tools）：`register(ToolDefinition)`/`restrict`/`guard`/`get`/`schemas`/`execute`/`presentAs`；事件 `tools/pre-execute`(waterfall)/`tools/execute`(around)/`tools/post-execute`(waterfall)/`tools/result`(emit)/`tools/change`(emit)。`defineTool` DSL：requiredness 是每属性 `required?: true` 注解（非 JSON Schema required 数组）；`output` 必填 `{schema, render}`；`execute(args, exec)`；`timeoutMs` 由 wrapper 强制；`isConcurrencySafe` 仅精确 true 才并行。
- `ctx.llm`（dsh-llm）：`registerAdapter(providers[], adapter)`（重复路由抛 `DUPLICATE_ADAPTER`，handle `.replace()` 原子换路由）/`registerConfigurableProviders`/`registerModelDiscovery(settingsNs, discover)`/`stream(options)`；`LlmAdapter` 唯一必选 `stream`；事件 `llm/stream` waterfall。
- 消息：`createUserMessage/createMessage/...` 构造即深冻结；`MessageSourceMap` merge-extensible：`user`/`plugin{kind:'plugin',plugin}`/`model`/`tool`；`ContextFormed`：form ∈ instructions/catalog/snapshot/notice/relay/recall。
- `ctx.webServer`（dsh-host-webserver）：`register({kind:'exact'|'prefix', path, handler})`——重复 (kind,path) 抛 `webserver: duplicate ${kind} route "${path}"`；`registerUpgrade`/`registerFallback`（单座位）同理；private 表 `exact/prefixes/upgrades` 运行时可触达。
- `ctx.agents`（dsh-agent）：`create/resume/register/get/list`；Agent 四注入边界 `send/followup/steer/inject`（inject=排进下一个 pre-step 不唤醒）；事件 `agent/pre-step`(waterfall，可拒/可换 messages)/`agent/request`/`agent/request-error`/`agent/turn-stopping`/`agent/error` 等；turn 生命周期 durable：`turn/start`、`turn/end{reason}`、`step/start`、`step/end`、`user/message`。
- `ctx.settings`（dsh-settings）：`register(ns, schema, {base})` → `SettingsScope{get/watch/patch/replace/describe}`；重复注册 fail loud；0.1.x 时代曾有 `SettingsScopeController.load()` 导出（EAC v5.1.0 移除，六内置插件被迫内联 shim）。

### 3.4 进程外面

- EAC Extension Host SDK V1（`dsh-desktop\lib\extension-host\sdk\index.js`，236 行）：`ctx = {id, dataDir, log(level,msg)截断2000, registerTool(name, meta|handler, handler?), on(event,cb)只读, provideContext(fn)宿主侧500ms超时即丢弃, settings.get/set/all}`；权限门 deny-by-default：`net.fetch`(域名白名单)/`fs`(路径白名单,win32大小写不敏感,dataDir恒在内)/`shell.exec`(需 permissions.shell===true,默认30s)/`env.get`(需 permissions.env===true)；硬边界=进程围栏(Job Object)+Core Profile 零写入；工具名限 `[A-Za-z0-9_.-]{1,64}`，经 Core Bridge 以 `eac_<pluginId>_<tool>` 注册。
- 官方进程外面：`dsh-sdk-app` + `dsh-sdk-jsonrpc-demo`（stdio JSON-RPC）、`dsh-acp-app`（ACP）、社区 MCP 桥（hermes-dsh-bridge 0.9.0）。
- EAC 守卫三层：结构守卫（cordis inject 白名单 + slot 声明校验，两代内核共有）；plugin-guard.js 静态扫描（TROJAN_REMOTE_EXEC/DOWNLOAD_EXEC/BASE64_EVAL/PERSISTENCE/EXFIL_ENV——env 读取 120 字符内外发向量即命中；JUNCTION_FOREIGN/SHADOW_COPY/PATCH_DUP_ID 等）；supervisor 状态机（starting→running/failed/retrying/quarantined/disabled，crashStreak 稳定 STABLE_MS 归零、连续 3 次启动失败隔离）。
- cordis-dynamic 沙箱：node:vm 新域，全局面 = tagged console + harness（handle/defineTool/registerTool）+ 受限 Node API 陷阱；**明确不是 containment**；`harness.registerTool` 归一化会把 JSON-Schema 风格 required 数组映射成 DSL 每属性注解。

---

## 4. 实证破坏点表（shim 靶子）

| # | 破坏点 | 旧行为 | 新行为 | 适配动作 |
|---|---|---|---|---|
| 1 | **V4 producer-owned source kind**（0.2.0） | `MessageSourceMap` 合法含 `{kind:'plugin', plugin:string}` | `assertV4MessageSources` 对 `kind==='plugin'` 抛 `SessionFormatError("format v4 message requires a producer-owned source kind")`（asar 偏移 ~55619300）；`rewriteV3MessageSource/rewritePluginSource` 迁移旧 wrapper | 一切注入改用 producer-owned kind `{kind:<producer名>, form:...}`（0.1.x 也合法，MessageSourceMap 可扩展） |
| 2 | **hostProtocolVersion: 4**（0.2.0 新字段） | bundle-manifest 无此字段 | release 清单 `hostProtocolVersion: 4`（偏移 3392161） | 能力位 `host.protocolVersion` 探测 |
| 3 | **peerDependencies 强制**（0.2.0） | 无任何运行时版本校验（0.1.x） | 安装时 pnpm 前解析 peers，"incompatible DSH peer" 拒装；启动时独立检查拒绝挂载；**豁免 = profile 级 `compatibility.json`**（精确 `pkg@version` → 允许的 runtime 版本列表，`plugin_manager` 工具 `list_version_exemptions` 管理） | peer-gate shim：检查 + 自动生成豁免（显式风险提示） |
| 4 | **`SettingsScopeController.load()` 移除**（EAC v5.1.0，0.1.x→rc.2 系） | 顶层导出可 import | 移除；六内置插件（compact/conversation-tweaks/openclaw-bridge/prompt-custom/session-manager/third-party-thinking）内联 use-sync-external-store shim | settings-scope shim：给 scope 补 `.load()` 兼容方法 + 保证 `registrations` Map 可删 |
| 5 | **logger 双 API** | cordis 面 `ctx.logger(name?)`（LoggerService: error/info/warn/debug）；EAC SDK 面 `ctx.log(level,msg)` | 两面不互通；`ctx.log` 在 cordis 主机面**不存在**，误用即在 apply() 抛错 → crashStreak 连坐 | logger shim：ctx 代理把 `ctx.log(...)` 路由到 `ctx.logger[level]` |
| 6 | **client slots 包缺失**（0.1.1） | 0.1.2 起有独立 `@deepseek-ai/dsh-client-ui-slots` | 0.1.1 契约内嵌 | slots 归一：manifest inject 引用识别 + doctor 报告；dshx.ui fail-soft |
| 7 | **webserver 重复路由** | 重复 (kind,path) 抛错拖垮树 | 同 | route-dedup shim：注册前预检 private 表（side-session 惯用法），命中即跳过+报告 |
| 8 | **boot 断言** | 静默挂起 | `auditRows` 显式报 `${id} (${name}): waiting for ${missing}` / `never started` | 适配层包裹目标插件：activate 失败 fail-open（noop + 报告），不拖垮树 |

补充（非破坏但重要）：undici 事件（dsh-market 缺 undici 致 ERR_CONNECTION_REFUSED，EAC v4.6 vendored 修复）——插件树对宿主 Node 依赖闭包敏感；link/file 安装的包**裸 import 解析不到宿主依赖树**，须 createRequire 从 profile node_modules 解析（记忆生态实证）。

---

## 5. 新协议预警清单（协议包扩展位的设计输入）

1. EAC `window.dshDesktop` **protocolVersion: 1**（ADR 0006）：壳↔内核接口第一版版本号化契约；退役语义 = JSON-RPC -32601 / HTTP 404；能力桩 `{ok:false, unavailable:true, capability, reason}`。
2. EAC ADR 0008 分发体系：builtin(16)/recommended(14, `dev.dsh-eac.desktop-recommended`)/external(19) 三分类；`.dshpack` 独立分发格式；`.sync/plugin-distribution.json` + `plugin-inventory-history.json` 账本；SHA-256/精确 commit 规则。
3. EAC 皮肤协议（ADR 0005）：skin.json（profile 兼容范围 `dsh-desktop-eac-ui-skin-profile@^0.3`、owner 反域名、层依赖）+ `tokens.css`（`--eac-shell-*` 单一事实源 + fallback 强制）+ `/skin/<file>` 白名单路由；**与 dsh 客户端 cordis 皮肤是两套协议**。
4. RFC #1846 registry v2 + `dsh-doctor/v1` 信封（pass|warn|fail|skip 四态 + artifactSha256/dshVersion/checkedAt 证据绑定 + release-train 认证）——最可能成为社区事实标准。
5. 官方 `evaluatePluginCompatibility`（@deepseek-ai/dsh-app-boot 导出，dsh-compat-vet 依赖的运行时探测缝）+ 官方 `compatibility.json` 豁免机制。
6. `@ccgui/plugin-sdk`（desktop-cc-gui）：带 trust boundary 的应用级插件 SDK，与 dsh 插件面平行。
7. LaplaceYoung/oh-my-dsh `docs/seams-reference.md`：ctx.* + 事件瀑布缝契约的社区参考表述。
8. DSHX "protocol-1" 工件标记（dshx.io）。
9. dsh-tauri manifest.jsonc `{version, dsh}` 区间对——事实上的插件↔内核兼容矩阵格式。
10. AIO/EAC 沉淀的 profile 写入约定：patch disabled 行正则、agent-presets YAML 块、patch-row-heal/profile-module-heal——未成文接口。
11. EAC v5 ready-line ↔ v6 WS boot.state：壳等待内核就绪的握手协议换形。

**现有兼容工具格局**（差异化定位）：dsh-compat-vet（运行时能力探测 evaluatePluginCompatibility + 三态 covered/not-covered/unknown，刻意拒绝版本硬映射，只读）；dsh-plugin-doctor（静态+沙箱冒烟+CI，`dsh plugin check`）；RFC #1846（注册表契约）；EAC plugin-shield / eac-core-bridge（唯一运行时桥接实现，但闭在自家壳内）。**协议翻译与跨变体运行时兜底 = 空白，即本项目生态位。**

---

## 6. 本机可实测矩阵与安全红线

| 变体 | 版本/内核 | 状态 | 测法 |
|---|---|---|---|
| 官方 CLI | 0.1.1-rc.2（全局 npm） | 活跃 | 隔离 DSH_HOME + headless 探针 |
| 官方 Desktop | 0.2.0-rc.2 | 活跃 | 同内核 npm 包探针；GUI 留实机点验 |
| EAC v5.3.6 | 0.1.2-alpha.1 | 活跃(10-01) | 同族 0.1.2-alpha.2~rc.1 近似 + L4 模拟 |
| EAC v4.4.1 | 0.1.0-rc.7~0.1.1-rc.2 系 | 休眠(8-30) | npm 同族近似 |
| DSHEAC-AIO | 0.1.1-rc.2 钉版 | 存在(9-07) | 同 CLI 探针 |

红线：官方桌面端与 EAC 共享 `~/.dsh` **不可同开**；guard safe-mode 自 9-7 仍 active（不自动解除）；全部测试用隔离 DSH_HOME，不触碰 live profile 与在跑实例。凭据格式必须扁平字符串映射（`version: "1"` + `KEY: "sk-…"`）。

## 7. 证据路径索引

- npm CLI 内核（0.1.1-rc.2）：`AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`（dsh-tools\dsh-llm\dsh-agent\dsh-host-webserver\dsh-settings 的 lib/types/*.d.ts）
- EAC v5 内核（0.1.2-alpha.1）：`AppData\Local\Programs\Deepseek-Harness-EAC-v5\dsh-desktop\`（plugin-guard.js、lib\supervisor\state-machine.js、lib\extension-host\sdk\index.js、dsh-cordis-client-runner）
- 官方 Desktop 内核（0.2.0-rc.2）：`AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（未压缩；SessionFormatError×738、assertV4MessageSources、auditRows、plugin-manager 文档偏移 ~53709500）
- AIO：`AppData\Local\Programs\DSHEAC-AIO\resources\app\`（sidecar\dist\lib\preset-sync.js / plugin-manager-patch.js / patch-row-heal.js、assets\plugins）
- 社区插件活体：`~\.dsh\profiles\web-desktop\node_modules\@dsh-external\`（dsh-side-session 0.2.8、dsh-super-injector 0.3.3、皮肤三件套）
- EAC SDK 活体：`~\.dsh\extensions\sample-sdk-plugin\`（SDK V1 全 API 面）
- 官方文档：github.com/deepseek-ai/deepseek-harness docs/（session-format-status、capability-seams、cordis-primer、tool-catalog、upgrade-guide/v0.1.7-rc.2）
- EAC ADR：github.com/DSH-EAC/DSH-Desktop-EAC docs/adr/（0002/0005/0006/0008）
- 事故记录：`~\.claude\projects\C--Users-qy160\memory\dsh-desktop.md`（V4 拒收 18:41 事故、双 market 路由冲突、junction 污染）
- 生态站：dshmarket.com（~4400 插件）、dshx.io、dsh.deepseek404.com、plugin.dshx.dev
