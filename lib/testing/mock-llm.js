// 测试基建：mock LLM adapter（离线闭环 agent loop，不需真实 API key）。
// 契约形状对照 0.1.1-rc.2 dsh-llm/lib/types：StreamChunk 七型联合、finish.reason={kind:'stop'}、
// PreparedAdapterCall.model=LlmResolvedModelInfo{provider,id,name}。

export const MOCK_PROVIDER = 'dshx-mock';
export const MOCK_MODEL = 'mock-1';
export const INJECT_MARKER = '__DSHX_PROBE_INJECT__';

export function createMockLlmAdapter({ logger = console, home = null } = {}) {
  const calls = [];
  async function* stream(options) {
    let injected = false;
    let nMessages = -1;
    let lastSources = [];
    try {
      const msgs = Array.isArray(options?.messages) ? options.messages : [];
      nMessages = msgs.length;
      lastSources = msgs.slice(-3).map(m => ({ kind: m?.source?.kind ?? null, role: m?.role ?? null, text: String(JSON.stringify(m?.content) ?? '').slice(0, 120) }));
      injected = JSON.stringify(msgs).includes(INJECT_MARKER);
    } catch { /* 检查失败不影响流 */ }
    calls.push({ injected, nMessages, lastSources, at: new Date().toISOString() });
    try {
      if (home) {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.join(home, 'dshx');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'mock-probe.json'), JSON.stringify({ calls }, null, 2), 'utf8');
      }
    } catch { /* 诊断落盘失败不影响流 */ }
    const text = injected ? 'MOCK_FINAL INJECT_VISIBLE' : 'MOCK_FINAL INJECT_MISSING';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  return {
    providerInfo: (p) => ({ id: p, name: 'dshx-mock (dsh-master-key probe)' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [{ provider: MOCK_PROVIDER, id: MOCK_MODEL, name: 'Mock 1' }],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    prepareCall: async (p, m) => ({ model: { provider: p, id: m, name: m }, stream }),
    stream,
    _calls: calls,
  };
}

// 注册 mock provider：先试纯对象（结构化 duck-type）；内核若做 instanceof 校验则
// 动态 subclass LlmAdapter 重试。返回 {ok, how, error?}。
export async function registerMockLlm(ctx, { logger = console, report = null, home = null } = {}) {
  const adapter = createMockLlmAdapter({ logger, home });
  try {
    await ctx.llm.registerAdapter([MOCK_PROVIDER], adapter);
    report?.event?.('mock-llm-registered', { how: 'plain-object' });
    return { ok: true, how: 'plain-object', adapter };
  } catch (err) {
    try {
      const mod = await resolveDshLlm();
      if (!mod?.LlmAdapter) throw new Error('LlmAdapter 类不可解析');
      class MockAdapter extends mod.LlmAdapter {
        providerInfo(p) { return adapter.providerInfo(p); }
        providerRetryPolicy(p) { return adapter.providerRetryPolicy(p); }
        listModels(p) { return adapter.listModels(p); }
        resolveModel(p, m, s) { return adapter.resolveModel(p, m, s); }
        prepareCall(p, m, s) { return adapter.prepareCall(p, m, s); }
        stream(o) { return adapter.stream(o); }
      }
      await ctx.llm.registerAdapter([MOCK_PROVIDER], new MockAdapter());
      report?.event?.('mock-llm-registered', { how: 'subclass' });
      return { ok: true, how: 'subclass', adapter };
    } catch (err2) {
      report?.event?.('mock-llm-failed', { reason: String(err2?.message || err2) });
      return { ok: false, error: String(err2?.message || err2) };
    }
  }
}

async function resolveDshLlm() {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const require = createRequire(import.meta.url);
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
  const roots = [process.env.DSHX_HOST_MODULES, process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules') : null, join(home, 'profiles', 'node_modules'), process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      const req = createRequire(join(root, '_resolve_.js'));
      const entry = req.resolve('@deepseek-ai/dsh-llm');
      return await import(new URL(`file://${entry.replace(/\\/g, '/')}`).href);
    } catch { /* 下一个锚点 */ }
  }
  return null;
}
