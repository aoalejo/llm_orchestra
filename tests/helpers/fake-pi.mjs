#!/usr/bin/env node
/**
 * `pi` falso para el smoke de proveedores directos (P00095): habla el stream `--mode json` justo lo
 * necesario para que el runner real lo parsee. Sin red.
 *
 * Variables (las lee de su entorno; el runner agrega ORCHESTRA_ROLE):
 *   FAKE_PI_COUNTER=<prefijo>   cuenta las invocaciones por rol en `<prefijo>.<rol>` (para asertar reintentos)
 *   FAKE_PI_ERROR=429|402|stall falla con eso …
 *   FAKE_PI_ROLE=<rol>          … sólo en ese rol (default: author)
 *   FAKE_PI_FAIL_FIRST=<n>      … sólo las primeras n invocaciones de ese rol (default: todas)
 * Sin error: el author deja un archivo en el cwd, el verifier contesta PASS, el scout un mapa.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const role = process.env.ORCHESTRA_ROLE || '';
let n = 1;
if (process.env.FAKE_PI_COUNTER) {
  const f = `${process.env.FAKE_PI_COUNTER}.${role}`;
  try { n = Number(fs.readFileSync(f, 'utf8')) + 1; } catch { n = 1; }
  fs.writeFileSync(f, String(n));
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } };

const err = process.env.FAKE_PI_ERROR;
const failsHere = err && role === (process.env.FAKE_PI_ROLE || 'author')
  && (!process.env.FAKE_PI_FAIL_FIRST || n <= Number(process.env.FAKE_PI_FAIL_FIRST));

out({ type: 'agent_start' });
out({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });

if (failsHere && err === 'stall') {
  // DeepSeek en cola: acepta el pedido y no emite nada del modelo. Se autolimita por si nadie lo mata.
  setTimeout(() => process.exit(2), 30000);
  setInterval(() => {}, 1000);
} else if (failsHere) {
  process.stderr.write(err === '402' ? '402 Payment Required: insufficient balance\n' : '429 Too Many Requests: rate limit exceeded\n');
  process.exit(1);
} else {
  let text = 'hecho';
  if (role === 'author') {
    fs.writeFileSync(path.join(process.cwd(), `fake-change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`), 'cambio del pi falso\n');
    text = '## RESUMEN\nfake author';
  } else if (role === 'verifier' || role === 'security-reviewer') {
    text = '{"verdict":"PASS","findings":[],"acceptance":[],"counterTests":[],"commandsRun":[]}';
  } else if (role === 'scout') {
    text = '- src/fake.js:1 — mapa de contexto (pi falso)';
  }
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop', model: 'fake' } });
  out({ type: 'agent_end' });
}
