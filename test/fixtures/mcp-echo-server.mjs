// L4 夹具：最小 MCP stdio server（行分隔 JSON-RPC 2.0），提供 echo 工具。
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'echo',
    description: '回显输入（MCP 测试工具）',
    inputSchema: { type: 'object', properties: { msg: { type: 'string', description: '要回显的文本' } }, required: ['msg'] },
  },
];

const impl = {
  echo: async (args) => ({ content: [{ type: 'text', text: `mcp-echo:${args?.msg ?? ''}` }] }),
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.method === 'initialize') {
    respond(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-echo-test', version: '0.1.0' } });
  } else if (msg.method === 'tools/list') {
    respond(msg.id, { tools });
  } else if (msg.method === 'tools/call') {
    Promise.resolve(impl[msg.params?.name]?.(msg.params?.arguments) ?? { content: [] })
      .then(r => respond(msg.id, r));
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
