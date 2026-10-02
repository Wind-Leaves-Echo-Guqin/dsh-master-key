# dsh-compat v0.1 验收报告

- 日期：2026-10-02
- 仓库：`C:\Users\qy160\dsh-compat`（7 个阶段 commit）
- 测试总口径：**离线套件 57/57 绿；真内核矩阵 6/6 PASS；真实插件样本 4/4；eac-sdk 发现面探针 5/5**

## 一、交付物清单

| 交付物 | 位置 | 状态 |
|---|---|---|
| 协议总线核心（probe/variant/bus/api/report/envelope/logger） | `lib/core/` | ✅ |
| dshx 稳定 API v1 | `lib/core/api.js` | ✅ |
| 协议包 SDK（dshx-pack@1） | `lib/pack-sdk.js` + `docs/pack-format.md` | ✅ |
| 内置包：cordis-bundle（9 shim：6 运行时 + 3 体检） | `lib/packs/cordis-bundle/` | ✅ |
| 内置包：eac-sdk（Extension Host SDK V1 模拟 + extensions 发现面） | `lib/packs/eac-sdk/` | ✅ |
| 变体描述库（11 变体，社区可贡献） | `variants/*.json` + `docs/variant-format.md` | ✅ |
| doctor 装前体检（dsh-doctor/v1 风格信封） | `lib/doctor/cli.mjs` | ✅ 骨架 |
| 协议断代史（考据底座，全部结论带证据路径） | `docs/protocol-chronicle.md` | ✅ |
| 测试套件 L1/L2/L3/L4 + 三套探针驱动 | `test/` + `scripts/` | ✅ |

## 二、测试证据

### L1 单元测试 + L2 镜像校验（离线，`npm test`）
57/57 通过。镜像覆盖：V4 producer-owned source 断言、webserver duplicate 路由、
peer-gate 区间判定（对照 dsh-tauri 兼容矩阵与 our-free-model 声明）、plugin-guard 静态规则。

### L3 真内核矩阵（`npm run probe:l3`）
六代 npm 内核 × 隔离 DSH_HOME × headless one-shot × mock LLM（离线闭环，无真实 API 调用）：

| 内核 | 结果 |
|---|---|
| 0.1.0-rc.7 | PASS |
| 0.1.1-rc.2 | PASS |
| 0.1.2-rc.1 | PASS |
| 0.1.5-rc.1 | PASS |
| 0.1.7-rc.2 | PASS |
| 0.2.0-rc.2（V4） | PASS |

每代验证点：适配器激活、夹具经协议包挂载、工具注册被内核接受、ctx.log shim、
dshx 注入桥消息**真实进入 agent loop 并被 LLM 收到**（INJECT_VISIBLE）、exit 0。

### 真实插件样本（`node scripts/run-samples.mjs 0.2.0-rc.2`）
| 样本 | 来源 | 结果 |
|---|---|---|
| eco-note（记忆生态 cordis 适配器） | 本机 dev 树 | ✓ 激活（tools+agents 服务等待全命中） |
| dsh-our-free-model 1.2.2 | 本机 web-desktop profile | ✓ 激活（llm 服务等待命中） |
| maid-atelier 皮肤（宿主半） | 本机 web-desktop profile | ✓ 激活 |
| dsh-side-session 0.2.8 | 本机 web-desktop profile | ✓ 激活（缺 webServer 由其自身优雅降级） |

### eac-sdk 发现面（`node scripts/run-eac-sdk.mjs 0.2.0-rc.2`）
真实 sample-sdk-plugin 活体（EAC isolated-SDK 协议）经 extensions/registry 发现面
在**官方内核**复活：discovered=1 / activated=1 / settings 落盘 ✓。

### 扩展性验收（"未来新协议"诉求的直接证明）
测试中的 toy 协议包（`test/l1/bus.test.mjs` 内联夹具）以 `dshx-pack@1` 格式从外部目录
载入、协商认领、包装激活，全程零核心代码改动。L1 loader 三件套（激活/异常隔离/无人认领）
均以此路径验证。

## 三、考据过程中实证并修掉的破坏性更新（均记入断代史）

1. **上游 hmr 依赖漂移**：0.1.1-rc.2 的 dsh-app-boot 需要 `hmr.registerConfig`（1.0.16），
   但 `^1.0.16` 使今日安装拉到 1.0.19（已移除该方法）→ npm 裸装的 0.1.1-rc.2 headless
   带任何 patch 层即启动失败。探针按能力判定（app-boot 引用 registerConfig 而已装 hmr
   缺失）自动钉回 1.0.16。
2. **hmr 需要内核以 `--expose-internals` 启动**（官方桌面端 sidecar 自带该 flag；
   npm CLI 探针需显式加）。
3. **patch 语义实锤**：顶层 `{id,...}` 是对既有条目的定向覆盖，插入新插件必须走
   `insert` 列表（`applyEntryPatches`）。
4. **cordis inject 守卫**：未声明服务连属性读取都被拒（"cannot get property X without
   inject"）；跨服务访问须走 `ctx.get()` 机会式读取；scoped 事件只投递 `global: true`
   监听器。
5. **cordis 把插件 apply 的返回值当清理 effect**（返回非函数 = "Invalid effect" 拖垮 fiber）。
6. **headless 的 hmr 条目默认 disabled** 且 profile-boot 自动创建时传 `{root:[]}` 缺
   `base` 必填字段 → 构造失败被 `_init` 静默吞掉 → 服务永不出现。
7. **compose 顺序**：headless runner 在自己 apply 里就执行任务，适配器必须先于它激活。

## 四、已知边界（如实声明）

1. GUI 桌面壳（官方 Desktop、EAC v5/v6）的**交互验证未做**——同内核族 CLI 内核已覆盖
   协议面，界面表现留《实机点验清单》（`docs/manual-verification-checklist.md`）。
2. EAC 私有内核 0.1.2-alpha.1 未发 npm，矩阵以 0.1.2-rc.1 近似（同族）。
3. dsh-tauri / desktop-cc-gui / DSHEAC-AIO / EAC v6 等**未装变体**：描述库按考据写成，
   `tested: research-only`，未实测。
4. `out-of-process` 协议包（dsh-sdk-app JSON-RPC / ACP / MCP 桥）与 `eac-shell-bridge`
   （window.dshDesktop v1）：v0.1 只留接口位，未实现（v0.2 内容）。
5. doctor 的 peer 判定是 advisory 镜像；0.2.0+ 的权威判定以内核安装器为准。
6. 适配器自身未经 0.2.0+ 安装器路径的 peer 强制实测（探针走 bundle 直挂）。

## 五、复现命令

```sh
cd C:\Users\qy160\dsh-compat
npm test                      # L1 + L2 + L4（57 项，离线）
npm run probe:l3              # 六代真内核矩阵
node scripts/run-samples.mjs 0.2.0-rc.2   # 真实插件样本
node scripts/run-eac-sdk.mjs 0.2.0-rc.2   # eac-sdk 发现面
node lib/doctor/cli.mjs <插件目录> --kernel 0.2.0-rc.2   # 装前体检
```
