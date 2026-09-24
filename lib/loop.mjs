/** Loop Ralph por tarea: autor → gate → verifier → aprobación, e integración. */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RUNS, SCRATCH, LEDGER, O } from './paths.mjs';
import { ensureDir, exists, readJson, writeJson, appendJsonl, now } from './util.mjs';
import { log, warn } from './log.mjs';
import { readAgent } from './agents.mjs';
import {
  extractLastJson, findingsSignature, gateCommands, workOrderText,
  pickAuthorVerifier, pickFallbackPair, recordUsage, budgetStatus, compactFindings, changesScope,
  blacklistModel, normalizeVerdict,
} from './pure.mjs';
import { pickKey } from './keys.mjs';
import { socraticodeGather, socraticodeOptions, buildScoutPrompt } from './scout.mjs';
import { callModel, runGate, writeDiff, runProcess, changedFiles } from './runner.mjs';
import { estimateRemaining } from './cost.mjs';
import { fetchUsage, keyQuotaMap } from './usage.mjs';import { readLedger, summarizeLedger } from './report.mjs';

/** Registra una llamada de rol en el ledger (T-01). */
function ledgerEntry(task, cycle, role, model, key, out, extra = {}) {
  appendJsonl(LEDGER, {
    ts: now(), task: task.id, cycle, role, model,
    key: key?.name ?? null,
    cost: out?.usage?.cost || 0,
    turns: out?.usage?.turns || 0,
    exhausted: !!out?.exhausted,
    timedOut: !!out?.timedOut,
    ...extra,
  });
}

/** Payload de `needs-decision` por cuota: costo estimado restante + cuota de la cuenta A. */
async function exhaustionDecision(ctx, task, state, cycle, maxCycles) {
  const { config } = ctx;
  let estimate = null;
  let orchestratorQuota = null;
  try { estimate = estimateRemaining({ summary: summarizeLedger(readLedger()), remainingTasks: ctx.remainingTasks ?? 1, maxCycles }); } catch { /* noop */ }
  try { orchestratorQuota = await fetchUsage(config, process.env[config.keys.orchestrator]); } catch { /* noop */ }
  return {
    reason: 'keys-exhausted', task: task.id, cycle,
    options: ['use_orchestrator', 'use_fallback_models', 'pause'],
    spentUsd: Number((state.spentUsd || 0).toFixed(6)),
    remainingTasks: ctx.remainingTasks ?? 1,
    estimatedRemainingUsd: estimate?.usd ?? null,
    estimate,
    orchestratorQuota,
    hint: 'decidí con estimatedRemainingUsd + orchestratorQuota; reintentá con decisions:{keys:"use_orchestrator"|"use_fallback_models"|"pause"}',
  };
}

export async function callScout(ctx, task, cycleDir) {
  const query = `Recon para la tarea ${task.id}: ${task.title}`;
  const providerPref = String(ctx.config.scout?.provider || 'auto').toLowerCase();

  // Mismo criterio que `scoutCommand`: si hay proveedor externo (SocratiCode) y
  // `synthesize:false`, los chunks del índice SON el mapa → 0 tokens y sin
  // esperar a un modelo (antes el loop siempre llamaba al LLM: ~10-15 min por
  // tarea aunque el índice tuviera todo).
  let external = null;
  if (ctx.runner !== 'stub' && providerPref !== 'llm') {
    external = await socraticodeGather(ctx.config, query);
    if (!external.ok) warn(`socraticode: ${external.reason}${external.detail ? ` — ${external.detail}` : ''}`);
    if (external.ok && socraticodeOptions(ctx.config).synthesize === false) {
      return {
        text: external.chunks,
        usage: { cost: 0, totalTokens: 0, input: 0, output: 0, turns: 0 },
        key: null,
        source: 'socraticode',
        timedOut: false,
      };
    }
  }

  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  const out = await callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: ctx.config.roles.scout, apiKey: key?.value,
    systemPrompt: readAgent('scout'),
    prompt: buildScoutPrompt({ query, task, external }),
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, 'scout.json'), cwd: ctx.workdir, role: 'scout',
  });
  if (out.exhausted && key) ctx.keyState.exhausted.add(key.name);
  return { ...out, key, source: external?.ok ? 'socraticode+llm' : 'llm' };
}

/**
 * Un modelo que el workspace NO puede usar (privacidad del proveedor: "trains on
 * request data") se saca del pool en el acto y queda en `models.exclude` del
 * config, que es persistente (el ranking lo respeta). Reintentar con el mismo
 * modelo devuelve siempre el mismo 400, así que no se gasta otro ciclo en él.
 * Devuelve true si el modelo era unusable (el caller decide reintentar).
 */
function dropUnusableModel(ctx, model, out) {
  if (!out?.unusableModel || !model) return false;
  const res = blacklistModel(ctx.config, model, {
    reason: out.errorMessage || 'modelo no usable en este workspace (privacidad)',
  });
  if (res.changed) {
    try {
      const configPath = path.join(O, 'config.json');
      if (exists(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`);
      writeJson(configPath, ctx.config);
    } catch (e) {
      warn(`no pude persistir el blacklist de ${model}: ${e.message}`);
    }
    warn(`  modelo NO usable (${model}) → fuera del pool y a models.exclude [${res.removedFrom.join(', ') || '—'}]${res.replacement ? ` · reemplazo: ${res.replacement}` : ''}`);
  }
  return true;
}


/** Extrae el bloque ## RESUMEN del autor (o los primeros 600 chars). */
export function extractSummary(text) {
  if (!text) return null;
  const m = String(text).match(/##\s*RESUMEN\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  const body = (m ? m[1] : String(text)).trim();
  return body.replace(/\s+/g, ' ').slice(0, 600);
}

/** Resultado compacto de un ciclo verde para devolver al chat. */
export function buildResult(task, state, cycle, cycleDir, verdicts, authorText) {
  const acceptance = (verdicts || []).flatMap((v) => v.acceptance || []).filter(Boolean).slice(0, 20);
  return {
    id: task.id,
    title: task.title,
    risk: task.risk,
    cycles: cycle,
    cost: Number((state.spentUsd || 0).toFixed(6)),
    verdict: (verdicts || []).some((v) => normalizeVerdict(v.verdict) !== 'PASS') ? 'FAIL' : 'PASS',
    findings: compactFindings(verdicts),
    acceptance,
    summary: extractSummary(authorText),
    diff: path.join(cycleDir, 'diff.patch'),
    gateLog: path.join(cycleDir, 'gate.log'),
  };
}

import { callVerifier } from "./verify.mjs";
import { callAuthor } from "./author.mjs";
export async function runTaskLoop(ctx, task, taskDir, opts = {}) {
  const { config } = ctx;
  const highRisk = (config.loop.highRiskLevels || []).includes(task.risk);
  const maxCycles = config.loop.maxCycles || 4;
  const stateFile = path.join(taskDir, 'state.json');
  const decisions = opts.decisions || ctx.decisions || null;

  let state = { cycle: 0, spentUsd: 0, tokens: { input: 0, output: 0 }, status: 'in-progress', lastSignature: null, repeats: 0, approved: false, useFallback: false, forcedAuthor: null };
  if (exists(stateFile)) {
    const prev = readJson(stateFile);
    if (prev.status === 'approved') return prev;
    if (prev.status === 'needs-approval' && opts.autoApprove) {
      prev.approved = true;
      prev.status = 'approved';
      prev.commitMessage = prev.commitMessage || `fix(${task.id}): ${task.title}`;
      if (prev.result) prev.result = { ...prev.result, status: 'approved', approved: true, commitMessage: prev.commitMessage };
      writeJson(stateFile, prev);
      return prev;
    }
    if (prev.status === 'needs-approval') return prev;
    if (prev.status === 'needs-decision' && !decisions) return prev;
    if (prev.status === 'in-progress') {
      state = { ...state, ...prev };
      log(`  resume desde ciclo ${state.cycle + 1} (costo previo $${state.spentUsd.toFixed(4)})`);
    } else {
      // Estado terminal (failed/done/blocked): arrancar de cero. Antes se heredaba
      // el `cycle` viejo y, si ya estaba en maxCycles, el loop no ejecutaba NINGÚN
      // ciclo (arranca en 5 con maxCycles 4) y además reusaba el scoutMap: la
      // corrida "fallaba" en segundos sin hacer nada y sin explicar por qué.
      warn(`  estado previo "${prev.status}" (ciclo ${prev.cycle ?? '?'}, $${(prev.spentUsd || 0).toFixed(4)}): arranco de cero`);
    }
  }
  const saveState = () => writeJson(stateFile, state);
  const finish = (status) => { state.status = status; saveState(); return state; };
  let lastAuthorText = state.lastAuthorText || null;

  // Cuota por key (T-07): una consulta por proceso; pickKey prioriza la que tiene más.
  if (ctx.runner !== 'stub' && !ctx.keyState.quota && config.keys?.usageAware !== false) {
    try { ctx.keyState.quota = await keyQuotaMap(config); } catch { /* sin datos: sigue el round-robin */ }
  }

  // Sin cuenta de workers: ni el scout arranca. Se decide antes de gastar nada.
  if (ctx.runner !== 'stub' && !pickKey(config, ctx.keyState, 'worker')) {
    const decision = decisions?.keys ?? (process.env.ALLOW_WORKER_FALLBACK === '1' ? 'use_orchestrator' : null);
    if (decision === 'use_orchestrator' && process.env[config.keys.orchestrator]) ctx.keyState.useOrchestratorKey = true;
    else if (decision === 'use_fallback_models') state.useFallback = true;
    else {
      state.decision = await exhaustionDecision(ctx, task, state, 0, maxCycles);
      return finish('needs-decision');
    }
  }

  // Scout (una vez)
  if (config.scout?.enabled && !state.scoutMap) {
    const s = await callScout(ctx, task, ctx.taskDir);
    if (dropUnusableModel(ctx, config.roles.scout, s)) {
      warn('scout: modelo no usable en este workspace; sigo sin mapa de contexto');
    } else {
      state.scoutMap = (s.text || '').slice(0, 6000);
      recordUsage(state, s.usage);
      ledgerEntry(task, 0, 'scout', s.source === 'socraticode' ? 'socraticode' : config.roles.scout, s.key, s);
      if (s.timedOut) warn('scout sin respuesta (timeout); sigo sin mapa de contexto');
      log(s.source === 'socraticode' ? '  scout: chunks del índice (0 tokens)' : '  scout: contexto comprimido');
    }
    saveState();
  }

  // T-03(b): baseline de gates sobre el worktree limpio. Si ya pasan, el gate no valida nada.
  if (ctx.runner !== 'stub' && config.gates?.baseline !== false && state.gateBaseline === undefined) {
    const baseCmds = gateCommands(config, task);
    if (baseCmds.length) {
      const baseline = await runGate(baseCmds, path.join(taskDir, 'gate-baseline.log'), ctx.workdir, config.gates?.timeoutMs || config.loop?.gateTimeoutMs || 20 * 60 * 1000);
      state.gateBaseline = baseline.ok;
      saveState();
      if (baseline.ok) warn('gate trivial: los gates ya pasan en el worktree limpio (no validan el cambio)');
    }
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
      const decision = decisions?.keys ?? (process.env.ALLOW_WORKER_FALLBACK === '1' ? 'use_orchestrator' : null);
      if (decision === 'use_orchestrator' && process.env[config.keys.orchestrator]) {
        warn('workers agotados → reutilizando cuenta del orquestador (A)');
        ctx.keyState.useOrchestratorKey = true;
        aKey = pickKey(config, ctx.keyState, 'worker');
      } else if (decision === 'use_fallback_models') {
        warn('workers agotados → usando modelos de fallback');
        state.useFallback = true;
      } else {
        warn('workers agotados → se necesita decisión del orquestador (chat)');
        state.cycle = cycle - 1;
        state.decision = await exhaustionDecision(ctx, task, state, cycle, maxCycles);
        return finish('needs-decision');
      }
    }
    const authorOut = await callAuthor(ctx, task, cycleDir, author, aKey, state.scoutMap);
    recordUsage(state, authorOut.usage);
    if (authorOut.exhausted && aKey) ctx.keyState.exhausted.add(aKey.name);
    lastAuthorText = authorOut.text || lastAuthorText;
    ledgerEntry(task, cycle, 'author', author, aKey, authorOut);

    // Modelo que el workspace no puede usar → fuera del pool y reintento con otro.
    if (dropUnusableModel(ctx, author, authorOut)) {
      state.cycle = cycle;
      saveState();
      continue;
    }

    // Timeout del autor → fallo reintentable: siguiente ciclo (no gasta verifier).
    if (authorOut.timedOut) {
      warn(`  autor ${author} sin respuesta (timeout); reintento en el próximo ciclo`);
      state.cycle = cycle;
      saveState();
      continue;
    }

    const budgetAfterAuthor = budgetStatus(config, state);
    if (!budgetAfterAuthor.ok) { warn(`presupuesto superado: ${budgetAfterAuthor.reason}`); state.status = 'blocked'; saveState(); return state; }

    // T-03: autor que no cambió nada → no gastar gate ni verifier.
    const changed = ctx.runner === 'stub' ? null : await changedFiles(ctx.workdir);
    if (changed && changed.length === 0) {
      warn('  diff vacío: el autor no cambió archivos; reintento');
      state.cycle = cycle; saveState(); continue;
    }
    // T-11: gate trivial → si no cambió nada del scope declarado, no vale.
    if (changed && config.gates?.requireChangedFiles && !changesScope(changed, task.scope)) {
      warn(`  gate: ningún cambio toca el scope declarado (${(task.scope || []).join(', ') || 'sin scope'}); reintento`);
      state.cycle = cycle; saveState(); continue;
    }

    // GATE
    const commands = gateCommands(config, task);
    const gate = ctx.runner === 'stub'
      ? (fs.writeFileSync(path.join(cycleDir, 'gate.log'), `# gate stub (sin ejecución real)\n${commands.join('\n')}\n`), { ok: true, results: [] })
      : await runGate(commands, path.join(cycleDir, 'gate.log'), ctx.workdir, config.gates?.timeoutMs || config.loop?.gateTimeoutMs || 20 * 60 * 1000);
    log(`  gate: ${gate.ok ? 'VERDE' : 'ROJO'}`);
    if (!gate.ok) { state.cycle = cycle; appendJsonl(LEDGER, { ts: now(), task: task.id, cycle, role: 'gate', ok: false }); saveState(); continue; }

    // T-05(c): si la tarea toca datos sensibles, no se llama a ningún modelo remoto.
    if (task.localOnly || config.verify?.localOnly) {
      warn('  verify.localOnly: verificación remota deshabilitada → needs-approval');
      const result = buildResult(task, state, cycle, cycleDir, [{ verdict: 'PASS', findings: [], localOnly: true }], lastAuthorText);
      state.result = { ...result, status: 'needs-approval', verifySkipped: true };
      return finish('needs-approval');
    }

    // VERIFY
    if (ctx.runner === 'stub') fs.writeFileSync(path.join(cycleDir, 'diff.patch'), '');
    else await writeDiff(ctx.workdir, path.join(cycleDir, 'diff.patch'));
    const verdicts = [];
    let verifierTimedOut = false;
    const v1 = await callVerifier(ctx, task, verifier, 'verifier', 'a', cycleDir);
    if (dropUnusableModel(ctx, verifier, v1.out)) { state.cycle = cycle; saveState(); continue; }
    recordUsage(state, v1.out.usage);
    ledgerEntry(task, cycle, 'verifier', verifier, v1.key, v1.out, { verdict: v1.verdict?.verdict ?? (v1.out?.timedOut ? 'UNKNOWN' : 'FAIL') });
    if (v1.out?.timedOut) { verifierTimedOut = true; warn(`  verifier ${verifier} sin respuesta (timeout) → reintento`); }
    verdicts.push(v1.verdict || { verdict: v1.out?.timedOut ? 'UNKNOWN' : 'FAIL', findings: [] });
    if (highRisk && config.loop.doubleVerifyHighRisk) {
      const second = config.roles.verifier.find((m) => m !== author && m !== verifier) || config.roles.verifier[0];
      const v2 = await callVerifier(ctx, task, second, 'verifier', 'b', cycleDir);
      if (dropUnusableModel(ctx, second, v2.out)) { state.cycle = cycle; saveState(); continue; }
      recordUsage(state, v2.out.usage);
      ledgerEntry(task, cycle, 'verifier', second, v2.key, v2.out, { verdict: v2.verdict?.verdict ?? (v2.out?.timedOut ? 'UNKNOWN' : 'FAIL') });
      if (v2.out?.timedOut) verifierTimedOut = true;
      verdicts.push(v2.verdict || { verdict: v2.out?.timedOut ? 'UNKNOWN' : 'FAIL', findings: [] });
      const securityModel = config.roles.security || config.roles.verifier[0];
      const vs = await callVerifier(ctx, task, securityModel, 'security-reviewer', 'sec', cycleDir);
      if (dropUnusableModel(ctx, securityModel, vs.out)) { state.cycle = cycle; saveState(); continue; }
      recordUsage(state, vs.out.usage);
      ledgerEntry(task, cycle, 'security-reviewer', securityModel, vs.key, vs.out, { verdict: vs.verdict?.verdict ?? (vs.out?.timedOut ? 'UNKNOWN' : 'FAIL') });
      if (vs.out?.timedOut) verifierTimedOut = true;
      verdicts.push(vs.verdict || { verdict: vs.out?.timedOut ? 'UNKNOWN' : 'FAIL', findings: [] });
    }
    writeJson(path.join(cycleDir, 'verdict.json'), verdicts);

    // T-02: timeout de verifier = fallo reintentable (rota el modelo en el próximo ciclo).
    if (verifierTimedOut) { state.cycle = cycle; saveState(); continue; }

    const budgetAfterVerify = budgetStatus(config, state);
    if (!budgetAfterVerify.ok) { warn(`presupuesto superado tras verificación: ${budgetAfterVerify.reason}`); state.status = 'blocked'; saveState(); return state; }

    const failed = verdicts.some((v) => normalizeVerdict(v.verdict) !== 'PASS' || (v.findings || []).some((f) => f.severity === 'high'));

    // Anti-loop: firma repetida
    const sig = findingsSignature(verdicts);
    if (failed && sig === state.lastSignature && sig !== '[]') {
      state.repeats += 1;
      warn(`  firma de findings repetida (${state.repeats})`);
      if (state.repeats >= (config.progress?.repeatSignatureLimit || 2)) {
        const decision = decisions?.stall;
        if (decision === 'park') { state.cycle = cycle - 1; return finish('blocked'); }
        if (decision === 'escalate' || decision === 'continue') {
          if (decision === 'escalate') {
            state.forcedAuthor = decisions?.model || config.roles.escalationAuthor;
            warn(`  forzando autor de escalado: ${state.forcedAuthor}`);
          }
          state.repeats = 0;
        } else {
          warn('  estancamiento → se necesita decisión del orquestador (chat)');
          state.lastSignature = sig;
          state.cycle = cycle - 1;
          state.decision = {
            reason: 'stalled', task: task.id, cycle, signature: sig,
            options: ['escalate', 'park', 'continue'],
            findings: compactFindings(verdicts),
            hint: 'reintentá con decisions:{stall:"escalate"|"park"|"continue"}',
          };
          return finish('needs-decision');
        }
      }
    } else { state.repeats = 0; }
    state.lastSignature = sig;
    state.cycle = cycle;

    if (failed) { saveState(); continue; }

    // Verde: en modo chat el orquestador (el chat) aprueba. `opts.autoApprove` mantiene
    // el flujo desatendido (--commit / --yes).
    const result = buildResult(task, state, cycle, cycleDir, verdicts, lastAuthorText);
    if (opts.autoApprove) {
      state.approved = true;
      state.commitMessage = state.commitMessage || `fix(${task.id}): ${task.title}`;
      state.result = { ...result, status: 'approved', approved: true, commitMessage: state.commitMessage };
      return finish('approved');
    }
    state.result = { ...result, status: 'needs-approval' };
    return finish('needs-approval');
  }

  state.result = state.result || {
    id: task.id, title: task.title, cycles: state.cycle,
    cost: Number((state.spentUsd || 0).toFixed(6)), verdict: 'FAIL', findings: [], acceptance: [], summary: null,
  };
  return finish('failed');
}

