# dsh-compat · dsh 通用插件适配层

让不同协议的 dsh（DeepSeek Harness）插件，通过本适配器在各变体与历代内核上持续可用。
**dsh 再出破坏性更新时，只给适配层加一条 shim/playbook 规则，而不是每个插件各修一遍。**

## 核心思想：协议总线

适配器核心不认识任何具体协议，只认识"协议包"（pack）：

```
宿主内核 ──唯一绑定点── dsh-compat core（协议总线）
                          ├─ 能力位探测（按运行时探测，不按版本号）
                          ├─ 变体识别（描述库驱动，未知变体结构探测归类）
                          ├─ 协议包协商（probeHost / canSpeak / wrapActivate / degrade）
                          └─ 统一降级信封 {ok:false, unavailable:true, capability, reason}
                                ▲
        ┌───────────────────────┼───────────────────────┐
   cordis-bundle 包        eac-sdk 包              （未来新协议 = 新包，
   官方四层静态面+shim     EAC Extension SDK 模拟     放 ~/.dsh/dshx/packs/ 即可，
                                                    核心零改动）
```

- **老插件**：经协议包包装后照常跑（`compat-loader` 按 patch 条目接管）。
- **新插件**：直接对 `dshx` 稳定 API 写，跨变体通用。
- **内核升级出新破坏**：加一条 shim 规则（数据）；**出新变体**：加一个变体描述文件（数据）；**出新协议**：写一个协议包（一个描述 + 一个映射模块）。核心代码不动。

## 目录

- `docs/protocol-chronicle.md` — dsh 历代版本与变体协议断代史（本项目的考据底座）
- `docs/pack-format.md` — 协议包格式与 pack SDK 规范
- `docs/variant-format.md` — 变体描述格式
- `docs/manual-verification-checklist.md` — GUI 桌面端实机点验清单
- `lib/` — 核心与内置协议包
- `test/` — L1 单测 / L2 镜像校验 / L3 真内核矩阵探针 / L4 SDK 模拟

## 测试

```sh
npm test                 # L1 + L2 + L4（离线）
npm run probe:l3         # L3：六代真内核 × 隔离 DSH_HOME headless 探针
```

## 状态

v0.1：协议总线 + cordis-bundle（9 shim）+ eac-sdk + doctor 骨架。已知边界见 `docs/acceptance-report.md`。

## License

MIT
