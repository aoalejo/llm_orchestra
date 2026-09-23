#!/usr/bin/env node
/**
 * Fake MCP server (stdio) para los tests. Implementa lo mínimo que usa el scout:
 * initialize, tools/list, tools/call de codebase_health / codebase_status / codebase_search.
 * Los logs van a stderr; stdout es sólo JSON-RPC (una línea por mensaje).
 */
import process from 'node:process';

const TOOLS = ['codebase_health', 'codebase_status', 'codebase_search', 'codebase_index'];

function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function toolText(name, args) {
  if (name === 'codebase_health') return 'SocratiCode — Infrastructure Health Check:\n[OK] Docker: Running\n[OK] Qdrant container: Running\n[OK] Embedding model (fake): Available';
  if (name === 'codebase_status') return `Project: ${args?.projectPath || '?'}\nStatus: green\nIndexed chunks: 42`;
  if (name === 'codebase_search') {
    return `Search results for "${args?.query}" (1 match):\n\n--- src/foo.ts (lines 1-3) [typescript] score: 0.9000 ---\nexport const foo = 1;\nexport function bar() { return foo; }`;
  }
  if (name === 'codebase_index') return 'Indexing started.';
  return `unknown tool ${name}`;
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } } });
    } else if (msg.method === 'tools/list') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: toolText(name, msg.params?.arguments) }], isError: false } });
    } else if (msg.id != null) {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
    // notifications sin id: se ignoran
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('fake-mcp listo\n');
