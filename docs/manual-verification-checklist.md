# 实机点验清单（GUI 桌面端）

自动探针覆盖了协议面，但桌面壳的**人机界面**只能在实机点验。以下按优先级排列，
全部操作只涉及观察，不改配置；测试均使用隔离环境已完成，本清单是你机器上的最终确认。

## 前置

- [ ] 关闭所有 dsh 实例（官方桌面端与 EAC 共享 `~/.dsh`，不可同开）
- [ ] 确认 guard safe-mode 状态（9-7 起一直 active；点验期间不解除）

## A. 官方桌面端（0.2.0-rc.2，主力形态）

1. [ ] 安装适配器：`dsh plugin --profile web-desktop add C:\Users\qy160\dsh-compat`
      （或把仓库 junction 进 profile node_modules 并在 bundles 加入 `dsh-compat`）
2. [ ] 重启桌面端，设置→插件清单应出现 `dsh-compat-core`
3. [ ] 对话中让 agent 调用 `dshx_probe_echo`（若挂了探针夹具）或任一经适配器挂载的工具，确认工具卡片可见
4. [ ] 若挂载 eco-note：制造一个报错后下一回合看是否出现【经验参考】（回归验证）
5. [ ] 设置页确认无新增报错弹窗；`%LOCALAPPDATA%\Programs\DeepSeek Harness` 日志无
      `never started` / `waiting for` 新增行

## B. EAC v5.3.6

1. [ ] 同样方式挂载适配器（bundles 或 junction）
2. [ ] 重启 EAC，确认 `dsh-compat-core` 激活、无 crashStreak/quarantine 提示
3. [ ] 若启用 eac-sdk 发现面：确认 extensions 里 enabled 的 isolated 插件被拉起
      （incidents.jsonl 应有 `eac-sdk-discovery` 事件）
4. [ ] plugin-guard 对适配器目录的扫描结果确认无 TROJAN_* 误报

## C. 皮肤类（deep-whale 系）

1. [ ] 经适配器挂载 maid-atelier/orca-link 后，Web UI 皮肤正常渲染
2. [ ] 切换皮肤（skin-manager）互斥机制不被适配器干扰

## D. DSHEAC-AIO（低优先级）

1. [ ] AIO 与适配器共处：确认 sidecar 的 patch 写入器不删适配器条目
      （incidents.jsonl 无 `pack-load-failed`）

## 记录方式

每项完成后在 `~/.dsh/dshx/`（或对应 profile）查看 `matrix.json` / `incidents.jsonl`，
把异常行贴回给开发会话即可。
