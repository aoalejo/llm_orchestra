/**
 * Cliente MCP mínimo sobre stdio (JSON-RPC 2.0, mensajes newline-delimited).
 *
 * Sirve para hablar con `socraticode` (u otro server MCP) sin agregar
 * dependencias. No implementa todo el protocolo: initialize + tools/call,
 * que es lo que necesita el scout.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

export function mcpConnect({ command, args = [], env = {}, cwd, clientInfo = { name: 'orchestra', version: '1.0.0' } } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  let stderr = '';
  let closed = false;
  let nextId = 1;
  const pending = new Map();

  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // logs no-JSON a stdout se ignoran
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (e) => { closed = true; failAll(e); });
  child.on('close', (code) => {
    if (closed) return;
    closed = true;
    failAll(new Error(`MCP server cerró (code ${code})`));
  });

  const request = (method, params, timeoutMs = 30000) => {
    if (closed) return Promise.reject(new Error('MCP server no disponible'));
    const id = nextId++;
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout en ${method}`)); }, timeoutMs);
      pending.set(id, {
        resolve: (r) => { clearTimeout(t); resolve(r); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  };

  const notify = (method, params) => { if (!closed) { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* noop */ } } };
  const close = () => { try { child.stdin.end(); } catch { /* noop */ } try { child.kill(); } catch { /* noop */ } };

  return { request, notify, close, clientInfo, getStderr: () => stderr };
}

/** Conecta, inicializa y ejecuta `fn(client)`; cierra siempre. */
export async function withMcp(opts, fn) {
  const client = mcpConnect(opts);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: opts.clientInfo || { name: 'orchestra', version: '1.0.0' },
    }, opts.initTimeoutMs ?? opts.timeoutMs ?? 120000);
    client.notify('notifications/initialized');
    return await fn(client);
  } finally {
    client.close();
  }
}

/** Llama una tool MCP y devuelve `{ text, isError, raw }`. */
export async function mcpCallTool(client, name, args, timeoutMs = 60000) {
  const raw = await client.request('tools/call', { name, arguments: args || {} }, timeoutMs);
  const text = (raw?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: !!raw?.isError, raw };
}
