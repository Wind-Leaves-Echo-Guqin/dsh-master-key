# 变体描述格式 variants/*.json

变体（variant）= 一种 dsh 运行形态（官方 CLI、某桌面壳、某整合包……）。
描述文件是**数据**：社区为任何新壳贡献一个 JSON 即可让适配层认识它，核心零改动。

```jsonc
{
  "id": "eac-v5",
  "family": "eac",                       // 协议族：official | eac | aio | wrapper | aggregator
  "summary": "Deepseek Harness EAC v5.x（Tauri 2 壳）",
  // 识别信号：全部命中才算该变体（按特异性从高到低排）
  "detect": [
    { "kind": "dirExists", "path": "%LOCALAPPDATA%\\Programs\\Deepseek-Harness-EAC-v5\\dsh-desktop" },
    { "kind": "fileContains", "path": "%LOCALAPPDATA%\\Programs\\Deepseek-Harness-EAC-v5\\dsh-desktop\\package.json", "needle": "\"version\": \"5." },
    { "kind": "env", "name": "DSH_VARIANT", "value": "eac" }
  ],
  // 该变体默认可用的协议包（按优先序）
  "packs": ["cordis-bundle", "eac-sdk"],
  // 协议面增量备注（给人看 + doctor 提示用）
  "surfaces": {
    "static": "官方 cordis patch 四层",
    "client": "官方 dsh.client.inject；0.1.2-alpha 起有独立 slots 包",
    "llm": "官方 ctx.llm",
    "outOfProc": "Extension Host SDK V1 + Job Object 围栏"
  },
  "adaptation": "high",                  // none | low | medium | high
  "kernelRange": "0.1.2-alpha.1（未发 npm，同族 alpha.2~rc.1 近似）",
  "cohabitation": "与官方桌面端共享 ~/.dsh，不可同开",
  "tested": "simulated",                 // local | simulated | research-only
  "notes": "plugin-guard 静态扫描 TROJAN_*；supervisor crashStreak 3 次隔离"
}
```

`detect.kind` 取值：
- `dirExists` / `fileExists`：路径存在（支持 `%LOCALAPPDATA%`/`%APPDATA%`/`%~` 环境展开）
- `fileContains`：文件内容含 needle
- `env`：环境变量等于 value
- `windowFlag`：client 半 `window.dshDesktop` 存在（仅浏览器上下文）

## 未知变体的归类

描述库全部不命中时，probe 走结构探测：
1. 找 `cordis.patch.yml` 处理逻辑 / `dsh.bundle.patch` 语义 → 归入 `official` 族，packs 取 `["cordis-bundle"]`；
2. 找 `extensions/registry.json` 发现面 → 追加 `eac-sdk` 族；
3. 都找不到 → `unknown`，只提供 dshx 最小面（log/settings），一切能力位按不可用报信封，矩阵报告显式标 `unknown`，**禁止猜**。

## 现有描述库清单

| id | adaptation | tested |
|---|---|---|
| official-cli | none（基准） | local |
| official-desktop | none（基准） | local（GUI 待点验） |
| eac-v4 | medium | simulated |
| eac-v5 | high | simulated |
| eac-v6 | high | research-only |
| dsheac-aio | low | local |
| dsh-tauri | low | research-only |
| desktop-cc-gui | high | research-only |
| oh-my-dsh-seams | low | research-only |
| pure-shell | none | research-only |
