/**
 * `--keys-check`: verifica cada key del pool con una llamada REAL mínima.
 *
 * Para qué sirve, si ya existe `--keys-status`:
 * `--keys-status` sólo dice que la variable está seteada y muestra la máscara.
 * Con varias cuentas rotando (y sobre todo cuando una se quedó sin saldo) lo que
 * hace falta saber es *cuál responde*. El loop detecta la cuenta agotada y la
 * saca del pool, pero recién cuando la usa: eso quema un ciclo de autor/verifier.
 * Este chequeo lo adelanta.
 *
 * Costo: una llamada corta por key con modelo barato (el de `scribe`, o el
 * primer `author`). Imprime tokens y costo por key, así además sirve para
 * auditar el gasto por cuenta.
 */
import process from 'node:process';
import { resolvePi, runProcess, getPiTimeout } from './runner.mjs';
import { workerKeyEntries } from './keys.mjs';
import { detectExhausted } from './pure.mjs';
import { maskKey } from './util.mjs';
import { log } from './log.mjs';

const PROMPT = 'Respondé solo: ok';

/** Extrae el último mensaje del assistant del stream JSON de pi. */
function lastAssistant(lines) {
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* líneas no-JSON (warnings, extensiones) se ignoran */
    }
  }
  const msgs = events.filter((e) => e.message && e.message.role === 'assistant').map((e) => e.message);
  return msgs[msgs.length - 1] ?? null;
}

async function probe({ pi, provider, model, apiKey, cwd, timeoutMs }) {
  const args = [
    '--mode', 'json', '-p', '--no-session',
    '--provider', provider,
    '--model', model,
    '--api-key', apiKey,
    PROMPT,
  ];
  const lines = [];
  const errChunks = [];
  const t0 = Date.now();
  const res = await runProcess(pi.command, [...pi.prefix, ...args], {
    shell: pi.shell,
    cwd,
    timeoutMs,
    onLine: (l) => { if (l.trim()) lines.push(l); },
    onStderr: (c) => errChunks.push(c),
  });
  const msg = lastAssistant(lines);
  const stderr = errChunks.join('');
  const errorMessage = msg?.errorMessage ?? null;
  const text = (msg?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const usage = msg?.usage ?? {};
  return {
    code: res.code,
    timedOut: !!res.timedOut,
    text,
    usage,
    errorMessage,
    stderr,
    secs: (Date.now() - t0) / 1000,
    // Igual que el loop: sólo señales de transporte, nunca el texto del modelo.
    exhausted: detectExhausted({ stderr, errorMessage }),
    spawnError: res.spawnError,
  };
}

export async function checkKeys(config, { cwd = process.cwd(), timeoutMs = 0 } = {}) {
  const pi = resolvePi(config);
  const provider = config.provider ?? 'opencode-go';
  const roles = config.roles ?? {};
  const workerModel = roles.scribe ?? (Array.isArray(roles.author) ? roles.author[0] : 'qwen3.8-flash');
  const orchestratorModel = roles.orchestrator?.model ?? workerModel;
  const orchName = config.keys.orchestrator;

  const targets = [];
  if (process.env[orchName]) {
    targets.push({ name: orchName, value: process.env[orchName], model: orchestratorModel, kind: 'orchestrator' });
  }
  for (const k of workerKeyEntries(config)) {
    targets.push({ ...k, model: workerModel, kind: 'worker' });
  }

  if (!targets.length) {
    log('no hay keys configuradas (revisá .orchestra/.env)');
    return { ok: false, results: [] };
  }

  log(`chequeo de keys: ${targets.length} key(s), modelo barato ${workerModel}`);
  const results = [];
  const budgetMs = timeoutMs || Math.min(getPiTimeout(), 180000);

  for (const t of targets) {
    const r = await probe({ pi, provider, model: t.model, apiKey: t.value, cwd, timeoutMs: budgetMs });
    let verdict;
    if (r.spawnError) verdict = 'ERROR de spawn';
    else if (r.timedOut) verdict = 'TIMEOUT';
    else if (r.exhausted) verdict = 'AGOTADA (sin saldo / límite)';
    else if (r.code === 0 && r.text) verdict = 'ok';
    else verdict = 'sin respuesta clara';

    results.push({ name: t.name, kind: t.kind, model: t.model, verdict, ...r });

    const cost = r.usage?.cost?.total ?? 0;
    const tokens = r.usage?.totalTokens ?? 0;
    log(
      `  ${verdict.padEnd(28)} ${t.kind.padEnd(12)} ${String(t.name).padEnd(30)} ${maskKey(t.value)}` +
        `${tokens ? `  ${tokens} tok` : ''}${cost ? `  $${cost.toFixed(5)}` : ''}  (${r.secs.toFixed(1)}s)`,
    );
    if (r.errorMessage) log(`      ↳ ${String(r.errorMessage).replace(/\s+/g, ' ').slice(0, 180)}`);
    else if (r.text) log(`      ↳ "${r.text.slice(0, 40)}"`);
  }

  const alive = results.filter((r) => r.verdict === 'ok');
  const workersAlive = alive.filter((r) => r.kind === 'worker');
  const orchAlive = alive.some((r) => r.kind === 'orchestrator');
  log('');
  log(`resumen: ${alive.length}/${results.length} keys vivas · orquestador ${orchAlive ? 'ok' : 'CAÍDO'} · workers ${workersAlive.length} vivos`);
  if (!orchAlive) log('  ⚠ sin la key del orquestador el loop no puede planificar ni juzgar');
  if (orchAlive && !workersAlive.length) log('  ⚠ sin workers vivos el loop no va a poder escribir código');
  if (workersAlive.length === 1) log('  ⚠ un solo worker vivo: el paralelismo de autor/verifier queda serializado');

  return { ok: orchAlive && workersAlive.length > 0, results };
}
