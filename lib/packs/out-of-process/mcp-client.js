// 最小 MCP stdio 客户端：行分隔 JSON-RPC 2.0（MCP stdio transport）。
// 覆盖适配层需要的子集：initialize → notifications/initialized → tools/list → tools/call。

import { spawn } from 'node:child_process';

export async function connectMcpServer(server, { logger = null, timeoutMs = 15_000 } = {}) {
  const child = spawn(server.command, server.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(server.env || {}) },
    cwd: server.cwd || undefined,
    windowsHide: true,
  });
  // unref：MCP server 是长驻子进程，不能阻住宿主的事件循环——否则 headless
  // 一次式任务的进程永远退不出去（实测 spawnSync ETIMEDOUT）。stdin 管道
  // 在宿主退出后关闭，server 侧 readline 自然收尾。
  child.unref();
  child.stdin?.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-800); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buffer += d;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`MCP ${msg.error.message ?? 'error'}`));
        else resolve(msg.result);
      }
    }
  });
  const request = (method, params, timeout) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 请求超时: ${method}${stderrTail ? ` | stderr: ${stderrTail.slice(-200)}` : ''}`));
    }, timeout ?? 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => {
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* 进程已退 */ }
  };

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-master-key', version: '0.2.0' },
  }, timeoutMs);
  notify('notifications/initialized', {});

  return {
    serverInfo: init?.serverInfo ?? null,
    request,
    notify,
    listTools: async () => (await request('tools/list', {}, timeoutMs))?.tools ?? [],
    callTool: async (name, args) => await request('tools/call', { name, arguments: args ?? {} }, timeoutMs),
    dispose: () => { try { child.kill(); } catch { /* ignore */ } },
    _child: child,
  };
}

// JSON Schema（MCP inputSchema）→ defineTool DSL 参数形态：
// 每属性 {type, description} + 必选者附 required:true；可选者必须省略 required。
export function inputSchemaToParameters(schema) {
  const out = {};
  const props = schema?.properties ?? {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const [k, v] of Object.entries(props)) {
    out[k] = { type: v?.type ?? 'string', ...(v?.description ? { description: v.description } : {}) };
    if (required.includes(k)) out[k].required = true;
  }
  return out;
}
