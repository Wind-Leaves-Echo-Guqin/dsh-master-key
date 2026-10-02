# dsh-master-key · 万能钥匙

**一把钥匙，开 dsh 生态所有的锁。**

这个项目最初只为解决一个问题：**dsh 的破坏性更新把社区插件一波波炸掉**。
内核从 0.1.x 到 0.2.x 换了会话格式和校验规则，EAC/官方/AIO 各变体各有一套插件机制，
一个在 0.1.5 上活得好好的插件，升级后可能整棵插件树起不来。挨个修插件是修不完的——
所以把"适配"本身做成一个插件：**内核怎么变，只改万能钥匙；插件不用动。**

## 它是怎么工作的

万能钥匙本体不认识任何具体协议，只认识"协议包"（pack）：

```
dsh 内核（任意变体/版本）──唯一绑定点── 万能钥匙核心（协议总线）
                                        ├─ 变体识别（描述库驱动，未知变体结构探测归类）
                                        ├─ 能力位探测（运行时探测，拒绝版本号硬映射）
                                        ├─ 协议包协商（probeHost / canSpeak / wrapActivate / degrade）
                                        └─ 统一降级信封 {ok:false, unavailable:true, capability, reason}
                                              ▲
              ┌───────────────────────────────┼───────────────────────────────┐
         cordis-bundle 包                 eac-sdk 包                      out-of-process 包
         官方 cordis 四层静态面            EAC Extension SDK 模拟           MCP server 桥
         + 6 条运行时 shim                 + extensions 发现面              （声明 dsh.mcp 即用）
         + 3 条装前体检
```

- **老插件**：在 `~/.dsh/dshx/config.json` 里点名要兼容谁，重启即用（fail-open：单个插件炸了只隔离上报，不拖垮插件树）。
- **新插件**：直接对 `dshx` 稳定 API 写，跨变体通用。
- **内核出新破坏**：加一条 shim 规则（数据）。**出新变体**：加一个变体描述文件（数据）。**出新协议**：写一个协议包（一个描述 + 一个映射模块）。核心零改动。

## 快速开始

```powershell
# 1. 装进某个 profile（junction 方式，不依赖 pnpm 解析）
New-Item -ItemType Junction -Path ~\.dsh\profiles\<profile>\node_modules\dsh-master-key -Target <本仓库路径>
# 2. 把 "dsh-master-key" 加入该 profile package.json 的 dsh.profile.bundles（第 2 位）
# 3. 告诉它要兼容谁
#    ~\.dsh\dshx\config.json:
#    { "targets": [ { "path": "C:/path/to/某插件/index.js" } ] }
# 4. 完全重启 dsh
```

装前体检：`node lib/doctor/cli.mjs <插件目录> --kernel <内核版本>`

## 验证（全部可复现）

```sh
npm test                            # 离线套件（L1 单测 + L2 镜像校验 + L4 模拟宿主）
npm run probe:l3                    # 六代 npm 内核 + EAC 私有内核实机矩阵
node scripts/run-samples.mjs        # 真实社区插件样本
node scripts/run-eac-sdk.mjs        # EAC SDK 插件在官方内核复活
node scripts/run-mcp.mjs            # MCP 桥在真内核握手注册
```

当前状态（2026-10-03，v0.2.0）：**离线 62/62；真内核矩阵 7/7**
（npm 六代 0.1.0-rc.7→0.2.0-rc.2 + EAC 私有 0.1.2-alpha.1）；真实插件样本 4/4；
EAC SDK 复活 5/5；MCP 桥 3/3。详见 [docs/acceptance-report.md](docs/acceptance-report.md)。

## 文档

- [docs/protocol-chronicle.md](docs/protocol-chronicle.md) — dsh 历代版本与变体协议断代史（本项目考据底座，每条结论带证据路径）
- [docs/pack-format.md](docs/pack-format.md) — 协议包格式与 pack SDK（给协议作者）
- [docs/variant-format.md](docs/variant-format.md) — 变体描述格式（给壳作者/用户）
- [docs/acceptance-report.md](docs/acceptance-report.md) — 验收报告与已知边界
- [docs/manual-verification-checklist.md](docs/manual-verification-checklist.md) — GUI 桌面端实机点验清单
- [docs/v0.2-roadmap.md](docs/v0.2-roadmap.md) — 路线图

## License

MIT
