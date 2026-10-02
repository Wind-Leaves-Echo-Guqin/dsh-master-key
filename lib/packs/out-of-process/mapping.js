// out-of-process 协议包：把 MCP server（stdio 传输）当 dsh 插件用。
// 插件在 package.json 声明：
//   "dsh": { "mcp": { "servers": { "<别名>": { "command": "node", "args": ["server.js"] } } } }
// 适配器为其完成 MCP 握手，枚举工具并以 `mcp_<别名>_<工具名>` 注册进 ctx.tools。

import { connectMcpServer, inputSchemaToParameters } from './mcp-client.js';

export default {
  async probeHost(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return { ok: false, reason: '无 cordis context' };
    return { ok: true, caps: {} };
  },

  async canSpeak(plugin) {
    const mcp = plugin.manifest?.dsh?.mcp;
    return mcp && typeof mcp === 'object' && mcp.servers ? 3 : 0;
  },

  async wrapActivate(plugin, hostCtx, opts = {}) {
    const { report = null, logger = null, config = {} } = opts;
    const manifest = plugin.manifest || {};
    const servers = manifest.dsh?.mcp?.servers || {};
    const connections = [];
    const registered = [];

    for (const [alias, server] of Object.entries(servers)) {
      let conn;
      try {
        conn = await connectMcpServer({ ...server, ...(config.serverOverrides?.[alias] || {}) }, { logger });
      } catch (err) {
        report?.fallback?.('mcp.connect', `MCP server "${alias}" 握手失败（fail-open 跳过）: ${err?.message || err}`, alias);
        continue;
      }
      connections.push(conn);
      let tools = [];
      try { tools = await conn.listTools(); } catch (err) {
        report?.fallback?.('mcp.listTools', `MCP server "${alias}" 工具枚举失败: ${err?.message || err}`, alias);
        tools = [];
      }
      for (const tool of tools) {
        if (!tool?.name) continue;
        const fullName = `mcp_${alias}_${tool.name}`;
        try {
          const dispose = hostCtx.tools.register({
            name: fullName,
            description: tool.description || '',
            parameters: inputSchemaToParameters(tool.inputSchema),
            execute: async (args) => {
              const result = await conn.callTool(tool.name, args);
              const text = (result?.content ?? [])
                .map(c => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
                .filter(Boolean).join('\n');
              return { text: text || JSON.stringify(result ?? null) };
            },
            output: {
              schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
              render: (_args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
            },
          });
          registered.push(fullName);
          report?.event?.('mcp-tool-registered', { tool: fullName, server: alias });
          void dispose;
        } catch (err) {
          report?.fallback?.('mcp.registerTool', `工具 ${fullName} 注册被内核拒绝（fail-open 跳过）: ${err?.message || err}`, fullName);
        }
      }
      report?.event?.('mcp-server-ready', { server: alias, tools: tools.length, serverInfo: conn.serverInfo?.name ?? null });
    }

    // 进程退出兜底：回收 MCP 子进程（unref 后不阻退出，但不留孤儿）
    const cleanup = () => { for (const c of connections) c.dispose(); };
    process.once('exit', cleanup);

    // MCP 插件自己的宿主半逻辑（如有）照常执行
    if (typeof plugin.entry?.apply === 'function') {
      await plugin.entry.apply(hostCtx, config);
    }

    return {
      activated: true, mode: 'mcp', servers: connections.length, tools: registered,
      _dispose: cleanup,
    };
  },

  degrade(capability, reason) {
    return { ok: false, unavailable: true, capability: `out-of-process.${capability}`, reason };
  },
};
