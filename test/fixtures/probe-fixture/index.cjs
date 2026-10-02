'use strict';
// L3 探针夹具：经 dsh-compat 的 compat 目标装载，在真内核上验证四件事：
//   1. compat 挂载链路打通（本文件被执行）
//   2. ctx.tools.register 接受手工 ToolDefinition（内核结构校验通过）
//   3. 日志面可用（ctx.log 经 shim 路由 / ctx.logger 原生）
//   4. dshx.context.provide 贡献者进入注入桥（marker 由 mock LLM 在流内确认）
// 结果写 $DSH_HOME/dshx/probe-fixture.json，headless 探针据此断言。

const fs = require('node:fs');
const path = require('node:path');

function peek(ctx, name) {
  // 先属性（shim 代理的直读面），被 cordis 守卫拒绝时回落 ctx.get
  try { const v = ctx[name]; if (v != null) return v; } catch { /* 守卫拒绝 → get 兜底 */ }
  try { const v = ctx.get ? ctx.get(name) : undefined; return v == null ? undefined : v; }
  catch { return undefined; }
}

module.exports.apply = async function apply(ctx) {
  const tools = peek(ctx, 'tools');
  const llm = peek(ctx, 'llm');
  const dshx = peek(ctx, 'dshx');
  const out = {
    ts: new Date().toISOString(),
    pid: process.pid,
    hasTools: !!tools,
    hasLlm: !!llm,
    hasAgents: !!peek(ctx, 'agents'),
    hasLogger: !!ctx.logger,
    hasDshx: !!dshx,
    hasSettings: !!peek(ctx, 'settings'),
  };

  try {
    if (tools && typeof tools.register === 'function') {
      tools.register({
        name: 'dshx_probe_echo',
        description: 'dsh-compat L3 探针工具：回显输入（验证内核接受手工 ToolDefinition）',
        parameters: {
          text: { type: 'string', required: true, description: '要回显的文本' },
        },
        execute: async (args) => ({ text: `probe-echo:${args?.text ?? ''}` }),
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
        },
      });
      out.toolRegistered = true;
    }
  } catch (e) { out.toolError = String(e?.message || e); }

  try {
    if (typeof ctx.log === 'function') { ctx.log('info', 'fixture-alive-via-log-shim'); out.logPath = 'ctx.log'; }
    else if (ctx.logger) { ctx.logger.info('fixture-alive-via-logger'); out.logPath = 'ctx.logger'; }
  } catch (e) { out.logError = String(e?.message || e); }

  try {
    if (dshx && dshx.context && typeof dshx.context.provide === 'function') {
      const r = dshx.context.provide(() => `fixture context up; marker ${'__DSHX_PROBE_INJECT__'} present`);
      out.provideOk = !!(r && r.ok);
      if (r && !r.ok) out.provideReason = r.reason;
    }
  } catch (e) { out.provideError = String(e?.message || e); }

  try {
    const home = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh');
    fs.mkdirSync(path.join(home, 'dshx'), { recursive: true });
    fs.writeFileSync(path.join(home, 'dshx', 'probe-fixture.json'), JSON.stringify(out, null, 2), 'utf8');
    out.resultWritten = true;
  } catch (e) { out.writeError = String(e?.message || e); }

  return 'fixture-done';
};
