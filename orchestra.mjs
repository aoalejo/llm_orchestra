#!/usr/bin/env node
/**
 * Lean Orchestrator v2 — driver del loop Ralph con verificación adversa.
 *
 * v2 agrega:
 *  - ejecución paralela en git worktrees (hasta loop.maxParallelTasks)
 *  - scout de contexto previo al ciclo
 *  - detección de estancamiento (firma de findings repetida)
 *  - meta-review del orquestador sobre los PASS (sampling)
 *  - presupuesto por tarea (corta y escala)
 *  - resume desde runs/<task>/state.json
 *  - merge agent para conflictos de integración
 *  - `--self-test` (sin red) y `--keys-status`
 *
 * Invariante: workers/verifiers NO commitean. Solo el driver commitea EN NOMBRE
 * del orquestador, y únicamente tras su APPROVE.
 *
 * Sin dependencias externas.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(SELF_DIR, 'templates');
const ROOT = process.cwd();
const O = path.join(ROOT, '.orchestra');
// Agentes: override de proyecto (.pi/agents) → agentes del paquete (global).
const AGENTS_DIR = process.env.ORCHESTRA_AGENTS_DIR
  || (fs.existsSync(path.join(ROOT, '.pi', 'agents')) ? path.join(ROOT, '.pi', 'agents') : path.join(SELF_DIR, 'agents'));
const RUNS = path.join(O, 'runs');
const SCRATCH = path.join(O, 'scratch');
const WORKTREES = path.join(O, 'worktrees');
const LEDGER = path.join(O, 'ledger.jsonl');

let VERBOSE = false;
const log = (...a) => console.log('[orchestra]', ...a);
const vlog = (...a) => { if (VERBOSE) console.log('[orchestra][v]', ...a); };
const warn = (...a) => console.warn('[orchestra][warn]', ...a);
const die = (m) => { console.error('[orchestra][error]', m); process.exit(1); };

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const appendJsonl = (p, o) => fs.appendFileSync(p, JSON.stringify(o) + '\n');
const now = () => new Date().toISOString();
const exists = (p) => fs.existsSync(p);
function safeReaddir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

function stripFrontmatter(s) {
  const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? s.slice(m[0].length) : s).trim();
}
function readAgent(name) {
  const p = path.join(AGENTS_DIR, `${name}.md`);
  if (!exists(p)) die(`agente no encontrado: ${p}`);
  return stripFrontmatter(fs.readFileSync(p, 'utf8'));
}
function loadEnv(file) {
  if (!exists(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = val;
  }
}
function maskKey(v) {
  if (!v) return '(vacía)';
  return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-3)}` : '***';
}
function parseArgs(argv) {
  const out = { task: null, all: false, plan: false, commit: false, yes: false, dryRun: false, verbose: false, selfTest: false, keysStatus: false, workers: null, noWorktrees: false, init: false, force: false, stub: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--all') out.all = true;
    else if (a === '--plan') out.plan = true;
    else if (a === '--commit') out.commit = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--keys-status') out.keysStatus = true;
    else if (a === '--workers') { const n = Number(argv[++i]); out.workers = Number.isFinite(n) && n > 0 ? n : null; }
    else if (a === '--no-worktrees') out.noWorktrees = true;
    else if (a === '--stub') out.stub = true;
    else if (a === 'init') out.init = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/* ─────────────────────────── helpers puros (testeables) ─────────────────────── */

function extractLastJson(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return JSON.parse(fences[i][1]); } catch { /* sigue */ }
  }
  // Objetos JSON de nivel raíz (se ignoran llaves anidadas y llaves dentro de strings).
  const candidates = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch { /* sigue */ }
  }
  return null;
}

function findingsSignature(verdicts) {
  return JSON.stringify(
    (verdicts || [])
      .flatMap((v) => (v.findings || []).map((f) => `${f.file || '?'}:${f.line || '?'}:${(f.problem || f.reason || '').slice(0, 80)}`))
      .sort(),
  );
}

function pathsConflict(a, b) {
  const na = a.replace(/\\/g, '/'); const nb = b.replace(/\\/g, '/');
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}
function isProtected(config, task) {
  const paths = config.protectedPaths || [];
  return (task.scope || []).some((s) => paths.some((p) => pathsConflict(s, p)));
}
// Versión estricta: evalúa los archivos que el diff realmente modificó (no solo el scope declarado).
function isProtectedChange(config, files) {
  const paths = config.protectedPaths || [];
  return (files || []).some((f) => paths.some((p) => pathsConflict(f, p)));
}
// Comandos de gate de una tarea: sus targets o todos los targets válidos (ignora claves $comment).
function gateCommands(config, task) {
  const gates = config.gates || {};
  const targets = task.targets?.length
    ? task.targets
    : Object.keys(gates).filter((k) => !k.startsWith('$') && Array.isArray(gates[k]));
  return targets.flatMap((t) => gates[t] || []);
}

function workOrderText(task, ctx) {
  return [
    `WORK ORDER`,
    `id: ${task.id}`,
    `título: ${task.title}`,
    `riesgo: ${task.risk}`,
    `contrato (Anexo): ${task.contractRef}`,
    `targets de gate: ${(task.targets || []).join(', ')}`,
    ``,
    `SCOPE (solo estos archivos):`,
    ...(task.scope || []).map((s) => `- ${s}`),
    ``,
    `ACCEPTANCE CRITERIA:`,
    ...(task.acceptance || []).map((a, i) => `${i + 1}. ${a}`),
    ``,
    ctx?.scoutMap ? `MAPA DE CONTEXTO (scout):\n${ctx.scoutMap}\n` : '',
    `STATE global: ${path.join(O, 'STATE.md')}`,
    `Directorio de trabajo: ${ctx?.workdir || ROOT}`,
  ].filter(Boolean).join('\n');
}

function pickAuthorVerifier(config, cycle, maxCycles, forced = null) {
  const authors = config.roles.author;
  const verifiers = config.roles.verifier;
  const last = cycle === maxCycles;
  const author = forced?.author
    || (last && config.roles.escalationAuthor ? config.roles.escalationAuthor : authors[(cycle - 1) % authors.length]);
  let verifier = forced?.verifier
    || (last && config.roles.escalationVerifier ? config.roles.escalationVerifier : verifiers[(cycle - 1) % verifiers.length]);
  if (verifier === author) verifier = verifiers.find((m) => m !== author) || verifiers[cycle % verifiers.length];
  return { author, verifier, last };
}

// Par de modelos de fallback (cuando se agota la cuenta B y el orquestador lo permite).
function pickFallbackPair(config, cycle) {
  const fb = config.fallback?.models || [];
  if (!fb.length) return null;
  const author = fb[(cycle - 1) % fb.length];
  const verifier = fb.find((m) => m !== author) || author;
  return { author, verifier };
}

// Suma usage al estado de la tarea (costo + tokens) y devuelve el costo.
function recordUsage(state, usage) {
  if (!usage) return 0;
  state.spentUsd = (state.spentUsd || 0) + (usage.cost || 0);
  state.tokens = state.tokens || { input: 0, output: 0 };
  state.tokens.input = (state.tokens.input || 0) + (usage.input || 0);
  state.tokens.output = (state.tokens.output || 0) + (usage.output || 0);
  return usage.cost || 0;
}

// Corte por presupuesto: costo y tokens de entrada/salida.
function budgetStatus(config, state) {
  const b = config.budget || {};
  const usd = state.spentUsd || 0;
  const input = state.tokens?.input || 0;
  const output = state.tokens?.output || 0;
  if (b.maxUsdPerTask && usd > b.maxUsdPerTask) return { ok: false, reason: `costo $${usd.toFixed(4)} > $${b.maxUsdPerTask}` };
  if (b.maxInputTokensPerTask && input > b.maxInputTokensPerTask) return { ok: false, reason: `input tokens ${input} > ${b.maxInputTokensPerTask}` };
  if (b.maxOutputTokensPerTask && output > b.maxOutputTokensPerTask) return { ok: false, reason: `output tokens ${output} > ${b.maxOutputTokensPerTask}` };
  return { ok: true };
}

function shouldMetaReview(config, highRisk, rng = Math.random) {
  const mr = config.metaReview || {};
  if (!mr.enabled) return false;
  if (mr.alwaysForHighRisk && highRisk) return true;
  return rng() < (mr.sampleRate || 0);
}

/* ─────────────────────────────── runtime ───────────────────────────────────── */

const EXHAUST_RE = /(quota|insufficient|rate.?limit|\b429\b|\b402\b|\b401\b|unauthor|no credits|billing|exhaust|payment required)/i;

function resolvePi(config) {
  const candidates = [process.env.ORCHESTRA_PI_CLI, config.piCli].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) return { command: process.execPath, prefix: [c], shell: false, label: c };
  }
  const cmd = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  return { command: cmd, prefix: [], shell: true, label: cmd };
}

function runProcess(command, args, { cwd = ROOT, env, shell = false, onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, out: '', err: String(e), spawnError: String(e) });
    }
    let out = '', err = '', buf = '';
    const timer = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs) : null;
    child.stdout.on('data', (d) => {
      const s = d.toString(); out += s;
      if (onLine) { buf += s; const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ''; for (const l of lines) onLine(l); }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && buf.trim()) onLine(buf);
      resolve({ code: code ?? 0, out, err });
    });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: 1, out, err, spawnError: e.message }); });
  });
}

function stubModel({ role, prompt }) {
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1 };
  if (role === 'orchestrator' || role === 'judge') {
    if (/aprob|audit|overturn|rechaz/i.test(prompt)) return { code: 0, text: '{"decision":"APPROVE","commitMessage":"chore(v2): stub","reason":"self-test"}', usage };
    return { code: 0, text: '{"stateMarkdown":"# STATE\\n(stub)","nextTask":"v2-self-test","workOrder":"stub"}', usage };
  }
  if (role === 'verifier' || role === 'security-reviewer') {
    return { code: 0, text: '{"verdict":"PASS","findings":[],"acceptance":[],"counterTests":[],"commandsRun":[]}', usage };
  }
  if (role === 'merge-agent') return { code: 0, text: '## CONFLICTOS\n- (stub) resuelto\n## GATE\nstub → ok', usage };
  if (role === 'scout') return { code: 0, text: '- (stub) mapa de contexto', usage };
  if (role === 'scribe') return { code: 0, text: 'done', usage };
  return { code: 0, text: '## RESUMEN\nstub', usage };
}

async function runPi(ctx) {
  const { pi, provider, model, apiKey, systemPrompt, prompt, tools, thinking, logFile } = ctx;
  const args = ['--mode', 'json', '-p', '--no-session', '--provider', provider];
  if (model) args.push('--model', model);
  if (apiKey) args.push('--api-key', apiKey);
  if (thinking) args.push('--thinking', thinking);
  if (tools && tools.length) args.push('--tools', tools.join(','));
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  args.push(prompt);

  const events = [];
  const res = await runProcess(pi.command, [...pi.prefix, ...args], {
    shell: pi.shell,
    cwd: ctx.cwd || ROOT,
    onLine: (line) => { if (!line.trim()) return; try { events.push(JSON.parse(line)); } catch { /* noop */ } },
  });

  let text = ''; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let stopReason = null, errorMessage = null, modelUsed = model ?? null;
  for (const ev of events) {
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const m = ev.message; usage.turns++;
      if (m.usage) { usage.input += m.usage.input || 0; usage.output += m.usage.output || 0; usage.cacheRead += m.usage.cacheRead || 0; usage.cacheWrite += m.usage.cacheWrite || 0; usage.cost += m.usage.cost?.total || 0; }
      if (m.model) modelUsed = m.model;
      if (m.stopReason) stopReason = m.stopReason;
      if (m.errorMessage) errorMessage = m.errorMessage;
      const t = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (t) text = t;
    }
  }
  if (logFile) {
    const safeArgs = args.map((a, i) => (args[i - 1] === '--api-key' ? '***' : a));
    fs.writeFileSync(logFile, JSON.stringify({ model, code: res.code, usage, stopReason, errorMessage, stderr: res.err, text, args: safeArgs }, null, 2));
  }
  const haystack = `${res.err}\n${errorMessage ?? ''}\n${text}`;
  return { code: res.code, text, usage, stopReason, errorMessage, stderr: res.err, spawnError: res.spawnError, exhausted: EXHAUST_RE.test(haystack), modelUsed };
}

async function callModel(ctx) {
  if (ctx.runner === 'stub') return stubModel(ctx);
  return runPi(ctx);
}

async function runGate(commands, logFile, cwd) {
  const results = []; let ok = true; let logText = `# gate ${now()}\n`;
  for (const cmd of commands) {
    log(`  gate: ${cmd}`);
    const r = await runProcess(cmd, [], { shell: true, cwd, timeoutMs: 20 * 60 * 1000 });
    const passed = r.code === 0;
    results.push({ command: cmd, code: r.code, passed });
    logText += `\n$ ${cmd}\n[exit ${r.code}]\n${r.out}\n${r.err}\n`;
    if (!passed) { ok = false; break; }
  }
  fs.writeFileSync(logFile, logText);
  return { ok, results };
}

async function writeDiff(cwd, file) {
  await runProcess('git', ['add', '-A', '-N'], { cwd });
  const r = await runProcess('git', ['diff', '--no-color'], { cwd });
  fs.writeFileSync(file, r.out || '');
  return r.out || '';
}

// Cola FIFO: serializa operaciones que tocan el repo raíz (merge, scribe, tasks.json)
// cuando hay tareas corriendo en paralelo.
function makeQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

async function changedFiles(cwd) {
  await runProcess('git', ['add', '-A', '-N'], { cwd });
  const r = await runProcess('git', ['diff', '--name-only'], { cwd });
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/* ───────────────────────────── worktrees ───────────────────────────────────── */

function linkWorktreeDeps(wtDir) {
  const targets = [
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, 'packages', 'shared', 'node_modules'),
    ...safeReaddir(path.join(ROOT, 'apps')).map((e) => path.join(ROOT, 'apps', e.name, 'node_modules')),
  ];
  for (const target of targets) {
    if (!exists(target)) continue;
    const linkPath = path.join(wtDir, path.relative(ROOT, target));
    if (exists(linkPath)) continue;
    ensureDir(path.dirname(linkPath));
    try { fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { warn(`no se pudo linkear ${path.relative(ROOT, target)}: ${e.message}`); }
  }
}

async function prepareWorktree(config, task) {
  if (!config.worktrees?.enabled) return { dir: ROOT, branch: null, ephemeral: false };
  const dir = path.join(ROOT, config.worktrees.dir || '.orchestra/worktrees', task.id);
  const branch = `${config.integration?.branchPrefix || 'orchestra/'}${task.id}`;
  fs.rmSync(dir, { recursive: true, force: true });
  await runProcess('git', ['worktree', 'prune'], {});
  await runProcess('git', ['branch', '-D', branch], {});
  const r = await runProcess('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], {});
  if (r.code !== 0) { warn(`worktree no creado (${task.id}); uso ROOT. ${r.err.trim()}`); return { dir: ROOT, branch: null, ephemeral: false }; }
  if (config.worktrees?.linkNodeModules !== false) linkWorktreeDeps(dir);
  return { dir, branch, ephemeral: true };
}
async function removeWorktree(config, task) {
  if (!config.worktrees?.enabled) return;
  const dir = path.join(ROOT, config.worktrees.dir || '.orchestra/worktrees', task.id);
  await runProcess('git', ['worktree', 'remove', '--force', dir], {});
  // Limpieza: tras integrar, la rama de la tarea ya cumplió su función.
  const branch = `${config.integration?.branchPrefix || 'orchestra/'}${task.id}`;
  await runProcess('git', ['branch', '-D', branch], {});
}

/* ─────────────────────────────── keys ──────────────────────────────────────── */

function makeKeyState() { return { workerKeyIdx: 0, exhausted: new Set() }; }

function pickKey(config, ks, role) {
  if (role === 'orchestrator' || role === 'judge') return { name: config.keys.orchestrator, value: process.env[config.keys.orchestrator] };
  const names = config.keys.workers.filter((n) => process.env[n]);
  for (let i = 0; i < names.length; i++) {
    const name = names[(ks.workerKeyIdx + i) % names.length];
    if (!ks.exhausted.has(name)) { ks.workerKeyIdx = (ks.workerKeyIdx + i + 1) % names.length; return { name, value: process.env[name] }; }
  }
  // Fallback decidido por el orquestador: reutilizar la cuenta A para workers.
  if (ks.useOrchestratorKey) return { name: config.keys.orchestrator, value: process.env[config.keys.orchestrator] };
  return null;
}
function keysStatus(config) {
  const rows = [
    ['orchestrator', config.keys.orchestrator, process.env[config.keys.orchestrator]],
    ...config.keys.workers.map((n) => ['worker', n, process.env[n]]),
  ];
  for (const [role, name, val] of rows) console.log(`${role.padEnd(13)} ${name.padEnd(34)} ${maskKey(val)}`);
}

/* ─────────────────────────── agent calls ───────────────────────────────────── */

async function callOrchestrator(ctx, instruction, logFile) {
  const rc = ctx.config.roles.orchestrator;
  const key = process.env[ctx.config.keys.orchestrator];
  return callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: rc.model, apiKey: key,
    systemPrompt: readAgent('orchestrator'), prompt: instruction, tools: ['read', 'grep', 'find', 'ls', 'bash'],
    thinking: rc.thinking, logFile, cwd: ROOT, role: 'orchestrator',
  });
}

async function callScout(ctx, task, cycleDir) {
  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  return callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: ctx.config.roles.scout, apiKey: key?.value,
    systemPrompt: readAgent('scout'), prompt: workOrderText(task, { workdir: ctx.workdir }),
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, 'scout.json'), cwd: ctx.workdir, role: 'scout',
  });
}

async function callVerifier(ctx, task, model, agentName, suffix, cycleDir) {
  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  const out = await callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model, apiKey: key?.value,
    systemPrompt: readAgent(agentName),
    prompt: `WORK ORDER:\n${workOrderText(task, { workdir: ctx.workdir })}\n\nDIFF: ${path.join(cycleDir, 'diff.patch')}\nGate log: ${path.join(cycleDir, 'gate.log')}\nZona de counter-tests (absoluta): ${SCRATCH}\n\nDevolvé el verdict JSON.`,
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, `verdict-${suffix}.json`), cwd: ctx.workdir, role: agentName,
  });
  if (out.exhausted && key) ctx.keyState.exhausted.add(key.name);
  return { verdict: extractLastJson(out.text), out, key };
}

/* ───────────────────────────── task loop ───────────────────────────────────── */

async function runTaskLoop(ctx, task, taskDir) {
  const { config } = ctx;
  const highRisk = (config.loop.highRiskLevels || []).includes(task.risk);
  const maxCycles = config.loop.maxCycles || 4;
  const stateFile = path.join(taskDir, 'state.json');

  let state = { cycle: 0, spentUsd: 0, tokens: { input: 0, output: 0 }, status: 'in-progress', lastSignature: null, repeats: 0, approved: false, useFallback: false, forcedAuthor: null };
  if (exists(stateFile)) {
    const prev = readJson(stateFile);
    if (prev.status === 'approved') return prev;
    if (prev.status === 'in-progress') { state = { ...state, ...prev }; log(`  resume desde ciclo ${state.cycle + 1} (costo previo $${state.spentUsd.toFixed(4)})`); }
  }
  const saveState = () => writeJson(stateFile, state);

  // Scout (una vez)
  if (config.scout?.enabled && !state.scoutMap) {
    const s = await callScout(ctx, task, ctx.taskDir);
    state.scoutMap = (s.text || '').slice(0, 6000);
    recordUsage(state, s.usage);
    saveState();
    log('  scout: contexto comprimido');
  }

  for (let cycle = state.cycle + 1; cycle <= maxCycles; cycle++) {
    const cycleDir = path.join(taskDir, `cycle-${cycle}`);
    ensureDir(cycleDir);
    const forced = state.useFallback ? pickFallbackPair(config, cycle) : (state.forcedAuthor ? { author: state.forcedAuthor } : null);
    const { author, verifier } = pickAuthorVerifier(config, cycle, maxCycles, forced);
    log(`  ciclo ${cycle}/${maxCycles}: author=${author} verifier=${verifier}${forced ? ' (forzado)' : ''}`);

    // AUTHOR
    let aKey = ctx.runner === 'stub' ? { name: 'stub', value: 'stub' } : pickKey(config, ctx.keyState, 'worker');
    if (!aKey) {
      const dec = await callOrchestrator(ctx, `Se agotó la cuenta de workers en ${task.id}. Respondé JSON {"action":"useOrchestratorKey|useFallbackModels|pause","reason":"..."}.`, path.join(cycleDir, 'escalation-key.json'));
      const d = extractLastJson(dec.text);
      const allowFallback = process.env.ALLOW_WORKER_FALLBACK === '1';
      if ((d?.action === 'useOrchestratorKey' || allowFallback) && process.env[config.keys.orchestrator]) {
        warn('workers agotados → reutilizando cuenta del orquestador (A) para esta tarea');
        ctx.keyState.useOrchestratorKey = true;
        aKey = pickKey(config, ctx.keyState, 'worker');
      } else if (d?.action === 'useFallbackModels' || allowFallback) {
        warn('workers agotados → usando modelos de fallback');
        state.useFallback = true;
      } else {
        warn('pausando por credenciales de workers agotadas');
        state.status = 'blocked'; saveState(); return state;
      }
    }
    const authorOut = await callModel({
      runner: ctx.runner, pi: ctx.pi, provider: config.provider, model: author, apiKey: aKey?.value,
      systemPrompt: readAgent('author'),
      prompt: workOrderText(task, { workdir: ctx.workdir, scoutMap: state.scoutMap }),
      tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'], logFile: path.join(cycleDir, 'author.json'), cwd: ctx.workdir, role: 'author',
    });
    recordUsage(state, authorOut.usage);
    if (authorOut.exhausted && aKey) ctx.keyState.exhausted.add(aKey.name);
    appendJsonl(LEDGER, { ts: now(), task: task.id, cycle, role: 'author', model: author, key: aKey?.name, cost: authorOut.usage?.cost || 0, turns: authorOut.usage?.turns || 0, exhausted: !!authorOut.exhausted });

    const budgetAfterAuthor = budgetStatus(config, state);
    if (!budgetAfterAuthor.ok) { warn(`presupuesto superado: ${budgetAfterAuthor.reason}`); state.status = 'blocked'; saveState(); return state; }

    // GATE
    const commands = gateCommands(config, task);
    const gate = ctx.runner === 'stub'
      ? (fs.writeFileSync(path.join(cycleDir, 'gate.log'), `# gate stub (sin ejecución real)\n${commands.join('\n')}\n`), { ok: true, results: [] })
      : await runGate(commands, path.join(cycleDir, 'gate.log'), ctx.workdir);
    log(`  gate: ${gate.ok ? 'VERDE' : 'ROJO'}`);
    if (!gate.ok) { state.cycle = cycle; appendJsonl(LEDGER, { ts: now(), task: task.id, cycle, role: 'gate', ok: false }); saveState(); continue; }

    // VERIFY
    if (ctx.runner === 'stub') fs.writeFileSync(path.join(cycleDir, 'diff.patch'), '');
    else await writeDiff(ctx.workdir, path.join(cycleDir, 'diff.patch'));
    const verdicts = [];
    const v1 = await callVerifier(ctx, task, verifier, 'verifier', 'a', cycleDir);
    recordUsage(state, v1.out.usage);
    verdicts.push(v1.verdict || { verdict: 'FAIL', findings: [] });
    if (highRisk && config.loop.doubleVerifyHighRisk) {
      const second = config.roles.verifier.find((m) => m !== author && m !== verifier) || config.roles.verifier[0];
      const v2 = await callVerifier(ctx, task, second, 'verifier', 'b', cycleDir);
      recordUsage(state, v2.out.usage);
      verdicts.push(v2.verdict || { verdict: 'FAIL', findings: [] });
      const securityModel = config.roles.security || config.roles.verifier[0];
      const vs = await callVerifier(ctx, task, securityModel, 'security-reviewer', 'sec', cycleDir);
      recordUsage(state, vs.out.usage);
      verdicts.push(vs.verdict || { verdict: 'FAIL', findings: [] });
    }
    writeJson(path.join(cycleDir, 'verdict.json'), verdicts);

    const budgetAfterVerify = budgetStatus(config, state);
    if (!budgetAfterVerify.ok) { warn(`presupuesto superado tras verificación: ${budgetAfterVerify.reason}`); state.status = 'blocked'; saveState(); return state; }

    const failed = verdicts.some((v) => v.verdict !== 'PASS' || (v.findings || []).some((f) => f.severity === 'high'));

    // Anti-loop: firma repetida
    const sig = findingsSignature(verdicts);
    if (failed && sig === state.lastSignature && sig !== '[]') {
      state.repeats += 1;
      warn(`  firma de findings repetida (${state.repeats})`);
      if (state.repeats >= (config.progress?.repeatSignatureLimit || 2)) {
        warn('  estancamiento detectado → escalando al orquestador');
        const dec = await callOrchestrator(ctx, `La tarea ${task.id} está estancada con los mismos findings:\n${sig}\n\nRespondé JSON {"action":"escalateModel|park|continue","model":"<opcional>","reason":"..."}.`, path.join(cycleDir, 'stall.json'));
        const d = extractLastJson(dec.text);
        if (d?.action === 'park') { state.status = 'blocked'; saveState(); return state; }
        if (d?.action === 'escalateModel') {
          state.forcedAuthor = d.model || config.roles.escalationAuthor;
          warn(`  forzando autor de escalado: ${state.forcedAuthor}`);
        }
        state.repeats = 0;
      }
    } else { state.repeats = 0; }
    state.lastSignature = sig;
    state.cycle = cycle;

    if (failed) { saveState(); continue; }

    // Meta-review del orquestador
    if (shouldMetaReview(config, highRisk)) {
      const audit = await callOrchestrator(ctx, `Auditá el PASS de ${task.id}. ¿Confirmás o revertís? Respondé JSON {"decision":"CONFIRM|OVERTURN","reason":"..."}.`, path.join(cycleDir, 'meta-review.json'));
      const a = extractLastJson(audit.text);
      if (a?.decision === 'OVERTURN') { warn('  meta-review REVERTIDO'); saveState(); continue; }
    }

    // Aprobación final
    const approval = await callOrchestrator(ctx,
      `Aprobá o rechazá ${task.id}.\nAcceptance:\n${(task.acceptance || []).join('\n')}\nGate OK. Verdicts: ${JSON.stringify(verdicts).slice(0, 3000)}\nDiff: ${path.join(cycleDir, 'diff.patch')}\n\nRespondé JSON {"decision":"APPROVE|REJECT","commitMessage":"...","reason":"..."}.`,
      path.join(cycleDir, 'approval.json'));
    const appr = extractLastJson(approval.text);
    log(`  orquestador: ${appr?.decision ?? 'sin respuesta'}`);
    if (appr?.decision !== 'APPROVE') { saveState(); continue; }

    state.approved = true;
    state.status = 'approved';
    state.commitMessage = appr.commitMessage || `fix(${task.id.replace(/^p0-|^v2-/, '')}): ${task.title} (Anexo ${task.contractRef || 'v2'})`;
    saveState();
    return state;
  }

  state.status = 'failed';
  saveState();
  return state;
}

/* ───────────────────────────── integration ─────────────────────────────────── */

async function integrateTask(ctx, task, wt, commitMessage) {
  if (!wt.ephemeral) return { ok: true, skipped: true };
  // Serializado: el merge toca ROOT y no debe solaparse entre tareas paralelas.
  return ctx.queues.git(async () => {
    // Commit en el worktree (en nombre del orquestador)
    await runProcess('git', ['add', '-A'], { cwd: wt.dir });
    const c = await runProcess('git', ['commit', '-m', commitMessage], { cwd: wt.dir });
    if (c.code !== 0 && !/nothing to commit/i.test(c.out + c.err)) return { ok: false, log: c.out + c.err };
    // Merge a la rama base
    const m = await runProcess('git', ['merge', '--no-ff', '--no-edit', wt.branch], { cwd: ROOT });
    if (m.code === 0) return { ok: true, log: m.out };
    // Merge agent
    if (ctx.config.integration?.mergeAgent) {
      warn(`conflicto al integrar ${task.id}; invocando merge-agent`);
      const key = pickKey(ctx.config, ctx.keyState, 'worker');
      const fix = await callModel({
        runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: ctx.config.roles.merge, apiKey: key?.value,
        systemPrompt: readAgent('merge-agent'),
        prompt: `Resolvé los conflictos de merge en ${ROOT} para integrar ${wt.branch}.\nEvento de merge:\n${(m.out + m.err).slice(0, 4000)}`,
        tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'], logFile: path.join(RUNS, task.id, 'merge-agent.json'), cwd: ROOT, role: 'merge-agent',
      });
      if (fix.exhausted && key) ctx.keyState.exhausted.add(key.name);
      await runProcess('git', ['add', '-A'], { cwd: ROOT });
      const mc = await runProcess('git', ['commit', '--no-edit'], { cwd: ROOT });
      if (mc.code === 0) return { ok: true, log: 'resuelto por merge-agent' };
    }
    await runProcess('git', ['merge', '--abort'], { cwd: ROOT });
    return { ok: false, conflict: true, log: m.out + m.err };
  });
}

/* ───────────────────────────── concurrency ─────────────────────────────────── */

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  await Promise.all(new Array(n).fill(0).map(async () => {
    while (true) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); }
  }));
  return results;
}

/* ───────────────────────────── init ───────────────────────────────────────── */

function initProject(force) {
  ensureDir(O);
  const files = [
    ['config.json', 'config.json'],
    ['STATE.md', 'STATE.md'],
    ['tasks.json', 'tasks.json'],
    ['env.example', 'env.example'],
    ['gitignore', '.gitignore'],
  ];
  for (const [src, dest] of files) {
    const from = path.join(TEMPLATES_DIR, src);
    const to = path.join(O, dest);
    if (!exists(from)) { warn(`plantilla faltante: ${from}`); continue; }
    if (exists(to) && !force) { log(`ya existe (no se toca): .orchestra/${dest}`); continue; }
    fs.copyFileSync(from, to);
    log(`creado .orchestra/${dest}`);
  }
  log('init listo. Editá .orchestra/config.json y completá .orchestra/.env');
}

/* ───────────────────────────── self-test ───────────────────────────────────── */

function selfTest() {
  const t = [];
  const eq = (name, cond) => t.push({ name, ok: !!cond });
  eq('extractLastJson bloque ```json', extractLastJson('foo\n```json\n{"verdict":"PASS","findings":[]}\n```\nbar')?.verdict === 'PASS');
  eq('extractLastJson objeto balanceado', extractLastJson('bla {"a":{"b":1},"c":"}"} fin')?.a?.b === 1);
  eq('extractLastJson null', extractLastJson('sin json') === null);
  eq('findingsSignature estable', findingsSignature([{ findings: [{ file: 'a', line: 1 }] }]) === findingsSignature([{ findings: [{ file: 'a', line: 1 }] }]));
  eq('isProtected detecta scope', isProtected({ protectedPaths: ['apps/backend/src/paisanitos/orders/'] }, { scope: ['apps/backend/src/paisanitos/orders/orders.service.ts'] }) === true);
  eq('isProtected ignora ajeno', isProtected({ protectedPaths: ['apps/backend/src/paisanitos/orders/'] }, { scope: ['apps/mobile/src/App.tsx'] }) === false);
  const wo = workOrderText({ id: 'x', title: 'T', risk: 'high', contractRef: '1', targets: ['backend'], scope: ['a.ts'], acceptance: ['pasa'] }, {});
  eq('workOrderText incluye acceptance', wo.includes('pasa') && wo.includes('a.ts'));
  eq('pickAuthorVerifier distintos', (() => { const c = { roles: { author: ['m1', 'm2'], verifier: ['m1', 'm2'] } }; const r = pickAuthorVerifier(c, 1, 4); return r.author !== r.verifier; })());
  eq('shouldMetaReview highRisk', shouldMetaReview({ metaReview: { enabled: true, alwaysForHighRisk: true } }, true) === true);
  eq('shouldMetaReview sample', shouldMetaReview({ metaReview: { enabled: true, sampleRate: 0 } }, false, () => 0.5) === false);
  eq('stub orchestrator APPROVE', JSON.parse(stubModel({ role: 'orchestrator', prompt: 'Aprobá' }).text).decision === 'APPROVE');
  eq('stub verifier PASS', JSON.parse(stubModel({ role: 'verifier', prompt: '' }).text).verdict === 'PASS');
  eq('pathsConflict raiz', pathsConflict('apps/x/', 'apps/x/y.ts') === true);
  eq('isProtectedChange detecta diff', isProtectedChange({ protectedPaths: ['apps/backend/prisma/migrations/'] }, ['apps/backend/prisma/migrations/001/x.sql']) === true);
  eq('isProtectedChange ignora ajeno', isProtectedChange({ protectedPaths: ['apps/backend/'] }, ['apps/mobile/App.tsx']) === false);
  eq('recordUsage acumula', (() => { const s = {}; recordUsage(s, { cost: 0.5, input: 10, output: 5 }); recordUsage(s, { cost: 0.25, input: 2, output: 1 }); return Math.abs(s.spentUsd - 0.75) < 1e-9 && s.tokens.input === 12 && s.tokens.output === 6; })());
  eq('budgetStatus corta por costo', budgetStatus({ budget: { maxUsdPerTask: 1 } }, { spentUsd: 1.5 }).ok === false);
  eq('budgetStatus corta por output', budgetStatus({ budget: { maxOutputTokensPerTask: 10 } }, { spentUsd: 0, tokens: { input: 0, output: 11 } }).ok === false);
  eq('budgetStatus ok', budgetStatus({ budget: { maxUsdPerTask: 1 } }, { spentUsd: 0.5, tokens: {} }).ok === true);
  eq('pickFallbackPair distintos', (() => { const p = pickFallbackPair({ fallback: { models: ['a', 'b'] } }, 1); return p && p.author !== p.verifier; })());
  eq('pickFallbackPair vacío', pickFallbackPair({ fallback: { models: [] } }, 1) === null);
  eq('pickAuthorVerifier forzado', (() => { const c = { roles: { author: ['m1'], verifier: ['m2'] } }; const r = pickAuthorVerifier(c, 1, 4, { author: 'zz' }); return r.author === 'zz' && r.verifier !== 'zz'; })());
  eq('parseArgs --workers inválido', parseArgs(['--workers', 'x']).workers === null);
  eq('parseArgs --workers válido', parseArgs(['--workers', '3']).workers === 3);
  eq('parseArgs --stub', parseArgs(['--stub']).stub === true);
  eq('gateCommands ignora $comment', (() => { const c = { gates: { $comment: 'no ejecutar', backend: ['a', 'b'] } }; return JSON.stringify(gateCommands(c, { targets: [] })) === JSON.stringify(['a', 'b']); })());
  eq('gateCommands respeta targets', (() => { const c = { gates: { backend: ['a'], mobile: ['m'] } }; return JSON.stringify(gateCommands(c, { targets: ['mobile'] })) === JSON.stringify(['m']); })());

  const failed = t.filter((x) => !x.ok);
  for (const x of t) console.log(`${x.ok ? '✓' : '✗'} ${x.name}`);
  console.log(`\nself-test: ${t.length - failed.length}/${t.length} OK`);
  process.exit(failed.length ? 1 : 0);
}

/* ─────────────────────────────── main ──────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Lean Orchestrator v2

  orchestra init [--force]          # scaffold .orchestra/ en el proyecto actual
  orchestra --self-test
  orchestra --keys-status
  orchestra --plan
  orchestra --task <id> [--commit] [--yes] [--dry-run]
  orchestra --all [--workers 4] [--no-worktrees]

Flags: --plan --task <id> --all --commit --yes --dry-run --workers <n> --no-worktrees --verbose --self-test --keys-status`);
    return;
  }
  if (args.selfTest) return selfTest();
  if (args.init) return initProject(args.force);

  if (!exists(path.join(O, 'config.json'))) die('falta .orchestra/config.json');
  const config = readJson(path.join(O, 'config.json'));
  VERBOSE = args.verbose;
  loadEnv(path.join(O, '.env'));            // antes de resolvePi: ORCHESTRA_PI_CLI puede venir del .env
  ensureDir(RUNS); ensureDir(SCRATCH); ensureDir(WORKTREES);

  if (args.keysStatus) { log('estado de credenciales:'); keysStatus(config); return; }

  const runner = args.stub || process.env.ORCHESTRA_RUNNER === 'stub' ? 'stub' : 'real';
  const pi = runner === 'stub' ? { label: 'stub', command: 'stub', prefix: [], shell: false } : resolvePi(config);
  const tasksFile = path.join(O, 'tasks.json');
  const tasksDoc = readJson(tasksFile);

  log(`pi: ${pi.label} | provider: ${config.provider} | runner: ${runner}`);
  if (!process.env[config.keys.orchestrator]) warn(`falta ${config.keys.orchestrator} en .orchestra/.env`);
  if (!config.keys.workers.some((k) => process.env[k])) warn(`falta alguna de ${config.keys.workers.join(', ')} en .orchestra/.env`);

  if (args.plan) {
    const state = fs.readFileSync(path.join(O, 'STATE.md'), 'utf8');
    const r = await callOrchestrator({ config, pi, runner, keyState: makeKeyState() },
      `Sos el orquestador. Actualizá el contexto global y elegí la próxima tarea.\n\nSTATE.md:\n${state}\n\nBacklog:\n${JSON.stringify(tasksDoc.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk })), null, 2)}\n\nRespondé SOLO JSON: {"stateMarkdown":"...","nextTask":"<id>","workOrder":"..."}.`,
      path.join(RUNS, 'plan.orchestrator.json'));
    const d = extractLastJson(r.text);
    if (d?.stateMarkdown) { fs.writeFileSync(path.join(O, 'STATE.md'), d.stateMarkdown.endsWith('\n') ? d.stateMarkdown : d.stateMarkdown + '\n'); log('STATE.md actualizado'); }
    console.log(r.text);
    return;
  }

  const pending = tasksDoc.tasks.filter((t) => t.status === 'pending' || t.status === 'in-progress');
  let selected;
  if (args.task) selected = [tasksDoc.tasks.find((t) => t.id === args.task)].filter(Boolean);
  else if (args.all) selected = pending;
  else selected = pending.slice(0, 1);
  if (!selected.length) { log('no hay tareas pendientes'); return; }

  const limit = args.noWorktrees ? 1 : (args.workers || config.loop.maxParallelTasks || 1);
  const ctx = { config, pi, runner, keyState: makeKeyState(), workdir: ROOT, taskDir: null, queues: { git: makeQueue(), book: makeQueue() } };
  const results = [];

  await runWithConcurrency(selected, limit, async (task) => {
    log(`\n=== tarea ${task.id} (${task.risk}) — ${task.title} ===`);
    const taskDir = path.join(RUNS, task.id); ensureDir(taskDir);
    const wt = await prepareWorktree(config, task);
    const tctx = { ...ctx, workdir: wt.dir, taskDir };
    const state = await runTaskLoop(tctx, task, taskDir);

    let integration = { ok: false, skipped: true };
    let protectedTask = isProtected(config, task);
    let protectedBy = protectedTask ? 'scope declarado' : null;

    if (state.approved) {
      // Chequeo estricto sobre los archivos que el diff realmente tocó.
      if (runner !== 'stub') {
        const changed = await changedFiles(wt.dir);
        if (isProtectedChange(config, changed)) { protectedTask = true; protectedBy = protectedBy || 'archivos modificados'; }
      }

      if (args.dryRun) {
        log(`  dry-run: commit propuesto -> ${state.commitMessage}`);
        integration = { ok: true, skipped: true, dryRun: true };
      } else if (args.commit) {
        if (protectedTask && !args.yes) warn(`ruta protegida (${protectedBy}): se requiere --yes; sin commit.`);
        else integration = await integrateTask(tctx, task, wt, state.commitMessage);
      } else {
        log('  sin --commit: no se integra; worktree conservado para inspección');
        integration = { ok: true, skipped: true };
      }

      const integrated = integration.ok && !integration.skipped;
      if (integrated) {
        // Scribe + backlog, serializado para no pisarse entre tareas paralelas.
        await ctx.queues.book(async () => {
          const key = pickKey(config, ctx.keyState, 'worker');
          await callModel({
            runner, pi, provider: config.provider, model: config.roles.scribe, apiKey: key?.value,
            systemPrompt: readAgent('scribe'),
            prompt: `La tarea ${task.id} pasó y fue integrada. Actualizá .orchestra/STATE.md (bitácora) y la matriz de cumplimiento si existe. NO edites tasks.json (lo hace el driver).`,
            tools: ['read', 'grep', 'find', 'ls', 'edit', 'write'], logFile: path.join(taskDir, 'scribe.json'), cwd: ROOT, role: 'scribe',
          });
          const fresh = readJson(tasksFile);
          const ft = fresh.tasks.find((t) => t.id === task.id);
          if (ft) ft.status = 'done';
          writeJson(tasksFile, fresh);
        });
      } else if (!args.dryRun) {
        log('  aprobada sin integrar: no se marca done (reintentá con --commit).');
      }
    } else if (!args.dryRun) {
      await ctx.queues.book(async () => {
        const fresh = readJson(tasksFile);
        const ft = fresh.tasks.find((t) => t.id === task.id);
        if (ft) { ft.status = state.status === 'blocked' ? 'blocked' : 'pending'; ft.attempts = (ft.attempts || 0) + (config.loop.maxCycles || 4); }
        writeJson(tasksFile, fresh);
      });
    }

    if (wt.ephemeral) {
      if (integration.ok && !integration.skipped) {
        await removeWorktree(config, task);
      } else {
        warn(`worktree conservado para inspección: ${wt.dir} (branch ${wt.branch})`);
      }
    }
    log(`=== fin ${task.id} — aprobada=${!!state.approved} — costo≈$${(state.spentUsd || 0).toFixed(4)} — integración=${integration.ok ? 'ok' : integration.skipped ? 'dry' : 'falló'} ===`);
    results.push({ task: task.id, ...state, integration });
  });

  writeJson(path.join(RUNS, 'last-run.json'), { ts: now(), results: results.map((r) => ({ task: r.task, status: r.status, approved: !!r.approved, spentUsd: r.spentUsd, integration: r.integration?.ok ?? null })) });
  log('\nresumen guardado en .orchestra/runs/last-run.json');
}

main().catch((e) => die(e?.stack || String(e)));
