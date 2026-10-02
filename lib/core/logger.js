// 日志面归一：cordis 面 ctx.logger（LoggerService：error/info/warn/debug，可 ctx.logger(name) 取命名 facade）。
// 禁止 ctx.log（那是 EAC Extension SDK 专属 API，cordis 面不存在，误用会在 apply() 抛错——见断代史 §4.5）。

export function makeLogger(ctx, report) {
  const L = ctx?.logger;
  if (typeof L === 'function') {
    try {
      const named = L('dsh-master-key');
      if (named && typeof named.info === 'function') return wrap(named);
    } catch { /* 命名 facade 失败继续尝试服务本体 */ }
    if (typeof L.info === 'function') return wrap(L);
  } else if (L && typeof L.info === 'function') {
    return wrap(L);
  }
  report?.fallback('dsh.logger', 'ctx.logger 不可用，回退 tagged console');
  const tag = '[dsh-master-key]';
  return wrap({
    info: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
    debug: () => {},
  });
}

function wrap(l) {
  return {
    info: (...a) => safe(() => l.info(...a)),
    warn: (...a) => safe(() => l.warn?.(...a)),
    error: (...a) => safe(() => l.error?.(...a)),
    debug: (...a) => safe(() => l.debug?.(...a)),
    _raw: l,
  };
}

function safe(fn) { try { fn(); } catch { /* 日志永不致命 */ } }
