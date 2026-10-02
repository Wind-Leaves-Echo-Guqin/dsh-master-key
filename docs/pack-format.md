# 协议包格式 dshx-pack@1

协议包（pack）是适配层的可插拔方言单元：**一种插件协议 = 一个包**。
核心总线不认识任何具体协议；新协议出现 = 新增一个包，核心零改动。

## 目录形态

```
my-protocol-pack/
├─ descriptor.json   # 声明：id、版本、宿主能力位要求、插件识别特征
├─ mapping.js        # 实现 pack SDK 四接口
└─ shims.json        # （可选）该协议下的破坏面规则，可增量
```

存放位置与优先级：
1. `~/.dsh/dshx/packs/<pack-id>/`（用户/社区目录，**默认停用**，需在 `~/.dsh/dshx/config.json` 显式 `"enable": ["<pack-id>"]`）
2. 适配器内置 `lib/packs/<pack-id>/`（随适配器分发，随适配器版本测试）

## descriptor.json

```jsonc
{
  "packFormat": 1,                    // 固定 1；核心只加载 packFormat <= 自身支持的包
  "id": "cordis-bundle",              // 全局唯一，[a-z0-9-]
  "version": "0.1.0",
  "summary": "官方 cordis 四层静态面",
  // 宿主能力位要求：全部满足才可 probeHost（缺了 = 包整体不可用，报 unavailable）
  "requiresHostCaps": ["cordis.ctx"],
  // 插件识别特征（canSpeak 依据，按顺序尝试，全部命中才认领）
  "pluginSignals": [
    { "kind": "manifestField", "path": "dsh.bundle.patch" },
    { "kind": "entryExport", "value": "apply" }
  ]
}
```

`pluginSignals.kind` 取值：
- `manifestField`：package.json 内 JSON Path 存在（可带 `value` 精确匹配）
- `entryExport`：入口模块具名导出存在
- `importSpecifier`：入口源码/import 元数据包含指定说明符（`value` 前缀匹配）
- `extensionKind`：仅限 eac-sdk 发现面（registry.json 的 kind 字段）

## mapping.js（pack SDK 四接口）

```js
export default {
  // 宿主可用性探测：返回 { ok:true, caps:{...} } 或 { ok:false, reason }
  // ctx 是内核 cordis context；caps 键名须先登记进 descriptor 无需，直接返回观测即可
  async probeHost(ctx) { ... },

  // 认领判断：给一个已解析的插件包（{manifest, entryModule, source}），返回 0~1 的认领度
  // 总线取最高分且 > 0 的包；平分时按 descriptor.pluginSignals 命中数
  canSpeak(plugin) { ... },

  // 包装激活：给 legacy 插件套上本协议的兼容上下文，返回新的 cordis apply 函数
  // hostCtx 是内核 context；pluginCtx 交给插件的应该是包装后的 context
  wrapActivate(targetModule, hostCtx, opts) { ... },

  // 能力降级：宿主缺某能力时的统一信封
  degrade(capability, reason) {
    return { ok: false, unavailable: true, capability, reason };
  }
};
```

## 约束（对包作者的硬性要求）

1. **不得 require 适配器核心私有模块**——包只经 pack SDK 接口与总线交互（信任边界对齐 EAC Extension Host 语义）。
2. **fail-open**：wrapActivate 内目标插件抛错不得外抛拖垮插件树（boot 断言会连坐全树），转为报告 + noop。
3. **一切降级走统一信封** `{ ok:false, unavailable:true, capability, reason }`，禁止静默吞错。
4. 日志只经 `hostCtx.logger`（cordis 面）；禁止 `ctx.log`（EAC SDK 专属，cordis 面无此方法）。
5. 能力探测禁止用版本号判断可用性——用运行时探测（函数存在性/行为探针）；版本号只许进报告。
6. 包的 shims.json 规则格式见 `lib/packs/cordis-bundle/shims.json` 的 `$schema` 注释，可随包版本增量追加。

## 总线协商顺序

```
probe(变体) → 载入可用包（requiresHostCaps 全过）→ 对目标插件逐一 canSpeak
→ 取最高分包 → wrapActivate → 激活失败 = quarantine 报告（错误签名入库，等 playbook 扩展）
```
