// 统一降级信封：一切"不可用"都必须显式、可查（见 docs/pack-format.md 约束 3）。
// 信封语义对齐 EAC v6 能力桩：{ ok:false, unavailable:true, capability, reason }。

export function unavailable(capability, reason, extra = undefined) {
  const env = { ok: false, unavailable: true, capability, reason };
  if (extra !== undefined) env.detail = extra;
  return env;
}

export function ok(value, extra = undefined) {
  const env = { ok: true, value };
  if (extra !== undefined) env.detail = extra;
  return env;
}

export function isEnvelope(v) {
  return v !== null && typeof v === 'object' && typeof v.ok === 'boolean';
}

export function isUnavailable(v) {
  return isEnvelope(v) && v.ok === false && v.unavailable === true;
}

// 解包便捷函数：信封取值，非信封原样返回（宽容老式插件直接返回裸值）。
export function unwrap(v, fallback) {
  if (isEnvelope(v)) return v.ok ? v.value : fallback;
  return v;
}
