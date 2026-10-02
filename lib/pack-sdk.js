// pack SDK：协议包的契约校验与工厂。包作者只依赖本文件暴露的概念（docs/pack-format.md）。

export const PACK_FORMAT = 1;

// 校验 descriptor；返回 { ok, errors[] }
export function validateDescriptor(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['descriptor 必须是对象'] };
  if (d.packFormat !== PACK_FORMAT) errors.push(`packFormat 必须是 ${PACK_FORMAT}（收到 ${d.packFormat}）；核心不加载更新格式的包`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(d.id || '')) errors.push('id 必须是 [a-z0-9-] 且以字母数字开头');
  if (typeof d.version !== 'string') errors.push('version 缺失');
  if (!Array.isArray(d.requiresHostCaps)) errors.push('requiresHostCaps 必须是数组（可为空）');
  if (!Array.isArray(d.pluginSignals)) errors.push('pluginSignals 必须是数组（可为空）');
  return { ok: errors.length === 0, errors };
}

// 包工厂：包作者入口。传入 descriptor + mapping，返回规范化 pack 对象。
export function definePack(descriptor, mapping) {
  const v = validateDescriptor(descriptor);
  if (!v.ok) throw new Error(`[dsh-compat] 协议包 descriptor 非法: ${v.errors.join('; ')}`);
  for (const fn of ['probeHost', 'canSpeak', 'wrapActivate', 'degrade']) {
    if (typeof mapping[fn] !== 'function') throw new Error(`[dsh-compat] 协议包 ${descriptor.id} 缺少 mapping.${fn}`);
  }
  return {
    descriptor: Object.freeze({ ...descriptor }),
    mapping: Object.freeze({ ...mapping }),
    shims: descriptor.shims ?? null,
    get id() { return descriptor.id; },
    get version() { return descriptor.version; },
  };
}
