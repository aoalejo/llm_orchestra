/**
 * Subcomandos "modo chat": el orquestador es el chat que los invoca.
 *
 *   orchestra scout    --query "..." [--scope a,b] [--task <id>] [--json]
 *   orchestra dispatch --order '<json>' [--order ...] | --orders <file.json> [--workers N] [--commit] [--json]
 *   orchestra approve  --task <id> [--message "..."] [--commit] [--yes] [--json]
 *   orchestra reject   --task <id> [--reason "..."] [--json]
 *   orchestra status   [--json]
 *
 * `executeTask` corre el loop (autor → gate → verifier → rondas) y, si se pidió
 * `commit`, integra. Devuelve SIEMPRE un resultado compacto (no transcripts).
 */
import path from 'node:path';
import process from 'node:process';
import { O, RUNS, ROOT, LEDGER } from './paths.mjs';
import { ensureDir, exists, readJson, writeJson, now, appendJsonl, makeQueue, runWithConcurrency } from './util.mjs';
import { log, warn, die } from './log.mjs';
import { readAgent } from './agents.mjs';
import { normalizeWorkOrder, validateWorkOrder, isProtected, isProtectedChange } from './pure.mjs';
import { makeKeyState, pickKey } from './keys.mjs';
import { callModel, changedFiles } from './runner.mjs';
import { prepareWorktree, removeWorktree } from './worktrees.mjs';
import { runTaskLoop, integrateTask } from './loop.mjs';
import { socraticodeGather, socraticodeOptions, scoutCacheKey, gitHead, readScoutCache, writeScoutCache, buildScoutPrompt } from './scout.mjs';
import { usageSnapshot } from './usage.mjs';

const TASKS_FILE = () => path.join(O, 'tasks.json');
const STATE_FILE = (id) => path.join(RUNS, id, 'state.json');

function readTasks() { try { return readJson(TASKS_FILE()); } catch { return { tasks: [] }; } }
function writeTasks(doc) { writeJson(TASKS_FILE(), doc); }
function safeRead(p) { try { return readJson(p); } catch { return null; } }

export function makeDeps(config, pi, runner) {
  return {
    config, pi, runner,
    keyState: makeKeyState(),
    workdir: ROOT,
    taskDir: null,
    queues: { git: makeQueue(), book: makeQueue() },
    remainingTasks: 0,
  };
}

export function findTask(id) { return readTasks().tasks.find((t) => t.id === id) || null; }

function emit(args, obj, human) {
  if (args.json) { console.log(JSON.stringify(obj, null, 2)); return; }
  if (human) human();
}

async function runScribe(deps, task, taskDir) {
  const { config, runner, pi } = deps;
  const key = pickKey(config, deps.keyState, 'worker');
  const out = await callModel({
    runner, pi, provider: config.provider, model: config.roles.scribe, apiKey: key?.value,
    systemPrompt: readAgent('scribe'),
    prompt: `La tarea ${task.id} pasó y fue integrada. Actualizá .orchestra/STATE.md (bitácora) y la matriz de cumplimiento si existe. NO edites tasks.json (lo hace el driver).`,
    tools: ['read', 'grep', 'find', 'ls', 'edit', 'write'], logFile: path.join(taskDir, 'scribe.json'), cwd: ROOT, role: 'scribe',
  });
  appendJsonl(LEDGER, { ts: now(), task: task.id, cycle: null, role: 'scribe', model: config.roles.scribe, key: key?.name ?? null, cost: out.usage?.cost || 0, turns: out.usage?.turns || 0, exhausted: !!out.exhausted, timedOut: !!out.timedOut });
}

function markTask(id, status, extra = {}) {
  const doc = readTasks();
  const t = doc.tasks.find((x) => x.id === id);
  if (t) { t.status = status; Object.assign(t, extra); }
  writeTasks(doc);
}

/** Corre una tarea completa (loop + integración opcional) → resultado compacto. */
export async function executeTask(deps, task, opts = {}) {
  const { config, runner } = deps;
  const taskDir = path.join(RUNS, task.id);
  ensureDir(taskDir);
  const reuse = exists(path.join(taskDir, 'state.json'));   // resumible: no recrear worktree
  const wt = await prepareWorktree(config, task, { reuse });
  const tctx = { ...deps, workdir: wt.dir, taskDir };
  const state = await runTaskLoop(tctx, task, taskDir, { autoApprove: opts.autoApprove, decisions: opts.decisions });

  let integration = { ok: false, skipped: true };
  let integrated = false;
  if (state.approved && opts.commit) {
    let protectedTask = isProtected(config, task);
    let protectedBy = protectedTask ? 'scope declarado' : null;
    if (runner !== 'stub') {
      const changed = await changedFiles(wt.dir);
      if (isProtectedChange(config, changed)) { protectedTask = true; protectedBy = protectedBy || 'archivos modificados'; }
    }
    if (opts.dryRun) integration = { ok: true, skipped: true, dryRun: true };
    else if (protectedTask && !opts.yes) warn(`ruta protegida (${protectedBy}): se requiere --yes; sin commit.`);
    else integration = await integrateTask(tctx, task, wt, state.commitMessage);
    integrated = integration.ok && !integration.skipped;
    if (integrated) {
      await deps.queues.book(async () => {
        await runScribe(deps, task, taskDir);
        markTask(task.id, 'done');
      });
      log(`  integrada ${task.id}: ${state.commitMessage}`);
    }
  } else if (!opts.dryRun) {
    // dry-run es read-only: no toca tasks.json.
    if (state.status === 'needs-approval') {
      await deps.queues.book(async () => markTask(task.id, 'review'));
    } else if (!state.approved) {
      await deps.queues.book(async () => {
        const doc = readTasks();
        const t = doc.tasks.find((x) => x.id === task.id);
        if (t && t.status !== 'done') { t.status = state.status === 'blocked' ? 'blocked' : 'pending'; t.attempts = (t.attempts || 0) + (state.cycle || 0); }
        writeTasks(doc);
      });
    }
  }

  if (wt.ephemeral) {
    if (integrated) await removeWorktree(config, task);
    else warn(`worktree conservado: ${wt.dir} (branch ${wt.branch})`);
  }

  return {
    ...(state.result || {}),
    status: state.status,
    approved: !!state.approved,
    cost: Number((state.spentUsd || 0).toFixed(6)),
    cycles: state.cycle || 0,
    decision: state.decision || null,
    integration,
    workdir: wt.ephemeral ? wt.dir : null,
    branch: wt.branch || null,
  };
}

/* ─────────────────────────────── scout ─────────────────────────────────── */

export async function scoutCommand(args, config, deps) {
  const task = args.task ? normalizeWorkOrder(findTask(args.task) || { id: args.task, title: args.task, acceptance: ['(sin acceptance)'] }, {}) : null;
  const query = args.query || (task ? `Recon para la tarea ${task.id}: ${task.title}` : 'Recon general del repo');
  const scope = Array.isArray(args.scope) ? args.scope : (args.scope ? String(args.scope).split(',') : []);
  const dir = path.join(RUNS, 'scout');
  ensureDir(dir);

  let providerPref = String(args.provider || config.scout?.provider || 'auto').toLowerCase();
  if (deps.runner === 'stub' && providerPref === 'auto') providerPref = 'llm';   // el stub no toca la red
  const ttl = args.noCache ? 0 : (config.scout?.cache?.maxAgeMinutes ?? 720);
  const cfg = args.index
    ? { ...config, scout: { ...config.scout, socraticode: { ...config.scout?.socraticode, autoIndex: true } } }
    : config;
  const o = socraticodeOptions(cfg);
  const head = await gitHead(deps.workdir || ROOT);
  const key = scoutCacheKey({ head, provider: providerPref, query, scope, projectPath: o.projectPath });

  const cached = readScoutCache(key, ttl);
  if (cached?.map) {
    const result = { status: 'ok', cached: true, source: cached.source || 'cache', map: cached.map, cost: 0, timedOut: false, file: path.join(dir, 'scout.map.json') };
    emit(args, result, () => console.log(result.map));
    return result;
  }

  // 1) Provider externo (SocratiCode) si corresponde.
  let external = null;
  if (providerPref === 'auto' || providerPref === 'socraticode') {
    external = await socraticodeGather(cfg, query);
    if (!external.ok) warn(`socraticode: ${external.reason}${external.detail ? ` — ${external.detail}` : ''}`);
  }

  // 2) synthesize:false → devolver los chunks sin gastar LLM.
  if (external?.ok && o.synthesize === false) {
    const result = { status: 'ok', source: 'socraticode', map: external.chunks, chunks: external.chunks, cost: 0, timedOut: false, file: path.join(dir, 'scout.map.json') };
    writeJson(path.join(dir, 'scout.map.json'), { ts: now(), query, scope, provider: 'socraticode', ...result });
    writeScoutCache(key, { map: result.map, source: 'socraticode' });
    emit(args, result, () => console.log(result.map || '(sin resultados)'));
    return result;
  }

  // 3) Scout LLM (con contexto externo si hay).
  const key2 = deps.runner === 'stub' ? { name: 'stub', value: 'stub' } : pickKey(config, deps.keyState, 'worker');
  if (!key2) {
    const out = { status: 'needs-decision', reason: 'keys-exhausted', options: ['use_orchestrator', 'use_fallback_models', 'pause'] };
    emit(args, out, () => warn(out.reason));
    return out;
  }
  const out = await callModel({
    runner: deps.runner, pi: deps.pi, provider: config.provider, model: config.roles.scout, apiKey: key2.value,
    systemPrompt: readAgent('scout'),
    prompt: buildScoutPrompt({ query, scope, task, external }),
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(dir, 'scout.json'), cwd: deps.workdir, role: 'scout',
  });
  const source = external?.ok ? 'socraticode+llm' : 'llm';
  const result = {
    status: out.timedOut ? 'timeout' : 'ok',
    source,
    map: (out.text || '').trim(),
    chunks: external?.ok ? external.chunks : null,
    cost: Number((out.usage?.cost || 0).toFixed(6)),
    timedOut: !!out.timedOut,
    file: path.join(dir, 'scout.json'),
  };
  writeJson(path.join(dir, 'scout.map.json'), {
    ts: now(), query, scope, provider: providerPref,
    external: external ? { ok: external.ok, reason: external.reason ?? null } : null,
    ...result,
  });
  if (result.status === 'ok' && result.map) writeScoutCache(key, { map: result.map, source });
  emit(args, result, () => console.log(result.map || '(sin mapa)'));
  return result;
}

/* ────────────────────────────── dispatch ───────────────────────────────── */

function parseOrders(args) {
  const list = [];
  if (args.ordersFile) {
    const doc = readJson(args.ordersFile);
    const arr = Array.isArray(doc) ? doc : (doc?.tasks || doc?.orders || []);
    for (const o of arr) list.push(o);
  }
  for (const raw of args.order || []) {
    try { list.push(JSON.parse(raw)); } catch (e) { die(`--order no es JSON válido: ${e.message}`); }
  }
  return list;
}

export async function dispatchCommand(args, config, deps) {
  const raw = parseOrders(args);
  if (!raw.length) die('dispatch: pasá --order \'<json>\' (repetible) o --orders <archivo.json>');
  const orders = [];
  for (const r of raw) {
    const base = r?.taskId ? (findTask(r.taskId) || {}) : {};
    const wo = normalizeWorkOrder(r, base);
    const errs = validateWorkOrder(wo);
    if (errs.length) { warn(`orden inválida (${wo.id}): ${errs.join(', ')}`); continue; }
    // ids únicos si el chat no los dio
    let id = wo.id;
    if (orders.some((o) => o.id === id)) id = `${id}-${orders.length + 1}`;
    orders.push({ ...wo, id });
  }
  if (!orders.length) die('dispatch: ninguna orden válida (revisá goal/acceptance/scope)');

  await deps.queues.book(async () => {
    const doc = readTasks();
    for (const o of orders) {
      const existing = doc.tasks.find((t) => t.id === o.id);
      if (existing) Object.assign(existing, o);
      else doc.tasks.push({ ...o, contractRef: o.contractRef, status: 'in-progress' });
    }
    writeTasks(doc);
  });

  const limit = args.noWorktrees ? 1 : (args.workers || config.loop.maxParallelTasks || 1);
  deps.remainingTasks = orders.length;
  log(`despachando ${orders.length} orden(es) con ${limit} worker(s): ${orders.map((o) => o.id).join(', ')}`);
  const results = await runWithConcurrency(orders, limit, (o) => executeTask(deps, o, {
    autoApprove: !!args.commit, commit: !!args.commit, yes: args.yes, dryRun: args.dryRun, decisions: args.decisions,
  }));

  const needsAttention = results.filter((r) => !r.approved && r.status !== 'approved');
  const out = {
    status: needsAttention.length ? 'needs-attention' : 'ok',
    cost: Number(results.reduce((a, r) => a + (r.cost || 0), 0).toFixed(6)),
    results,
  };
  emit(args, out, () => {
    for (const r of results) {
      const mark = r.approved ? '✓' : r.status === 'needs-approval' ? '⏳' : r.status === 'needs-decision' ? '❓' : '✗';
      log(`${mark} ${String(r.id).padEnd(24)} ${String(r.status).padEnd(15)} ${String(r.verdict || '').padEnd(5)} $${r.cost}  ${r.diff || ''}`);
    }
    if (needsAttention.length) log(`requieren decisión/aprobación: ${needsAttention.map((r) => r.id).join(', ')}`);
  });
  return out;
}

/* ─────────────────────────── approve / reject ──────────────────────────── */

export async function approveCommand(args, config, deps) {
  if (!args.task) die('approve: falta --task <id>');
  const stateFile = STATE_FILE(args.task);
  const st = safeRead(stateFile);
  if (!st) die(`approve: no hay state.json para ${args.task}`);
  if (!st.approved && st.status !== 'needs-approval') die(`approve: ${args.task} no está pendiente de aprobación (status=${st.status})`);
  if (args.message) { st.commitMessage = args.message; writeJson(stateFile, st); }
  const task = findTask(args.task) || normalizeWorkOrder({ id: args.task, title: args.task }, {});
  const result = await executeTask(deps, task, { autoApprove: true, commit: !!args.commit, yes: args.yes, dryRun: args.dryRun });
  emit(args, result, () => log(`aprobada ${task.id} — integración=${result.integration?.ok ? 'ok' : result.integration?.skipped ? 'dry' : 'no'}`));
  return result;
}

export async function rejectCommand(args, config, deps) {
  if (!args.task) die('reject: falta --task <id>');
  const stateFile = STATE_FILE(args.task);
  const st = safeRead(stateFile);
  if (st) { st.status = 'rejected'; st.rejectedReason = args.reason || null; writeJson(stateFile, st); }
  await deps.queues.book(async () => markTask(args.task, 'pending'));
  await removeWorktree(config, { id: args.task });
  const out = { status: 'rejected', id: args.task, reason: args.reason || null };
  emit(args, out, () => log(`rechazada ${args.task}${args.reason ? ` — ${args.reason}` : ''}`));
  return out;
}

/* ─────────────────────────────── usage ────────────────────────────────── */

export async function usageCommand(args, config) {
  const snap = await usageSnapshot(config, { noCache: !!args.noCache });
  const out = { ts: now(), accounts: snap };
  emit(args, out, () => {
    if (!snap.length) { log('sin keys configuradas (revisá .orchestra/.env)'); return; }
    const p = (w) => (w ? `${w.percent}%` : '-');
    for (const a of snap) {
      if (!a.usage) { log(`${String(a.role).padEnd(14)} ${String(a.name).padEnd(30)} sin datos`); continue; }
      log(`${String(a.role).padEnd(14)} ${String(a.name).padEnd(30)} rolling=${p(a.usage.rolling)} weekly=${p(a.usage.weekly)} monthly=${p(a.usage.monthly)}`);
    }
  });
  return out;
}

/* ─────────────────────────────── status ────────────────────────────────── */

export function statusCommand(args, config) {
  const doc = readTasks();
  const tasks = doc.tasks.map((t) => {
    const st = safeRead(STATE_FILE(t.id));
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      state: st?.status ?? null,
      approved: !!st?.approved,
      cycles: st?.cycle ?? 0,
      cost: Number(((st?.spentUsd) || 0).toFixed(6)),
      decision: st?.decision ?? null,
      result: st?.result ?? null,
    };
  });
  const out = { ts: now(), tasks };
  emit(args, out, () => {
    if (!tasks.length) { log('sin tareas'); return; }
    for (const t of tasks) {
      log(`${String(t.id).padEnd(28)} tasks=${String(t.status).padEnd(12)} state=${String(t.state).padEnd(15)} $${t.cost}  ${t.decision ? `decision=${t.decision.reason}` : ''}`);
    }
  });
  return out;
}
