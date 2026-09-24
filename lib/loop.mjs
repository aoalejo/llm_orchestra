/** Loop Ralph por tarea: autor → gate → verifier → aprobación, e integración. */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RUNS, SCRATCH, LEDGER } from './paths.mjs';
import { ensureDir, exists, readJson, writeJson, appendJsonl, now } from './util.mjs';
import { log, warn } from './log.mjs';
import { readAgent } from './agents.mjs';
import {
  extractLastJson, findingsSignature, gateCommands, workOrderText,
  pickAuthorVerifier, pickFallbackPair, recordUsage, budgetStatus, compactFindings, changesScope,
} from './pure.mjs';
import { pickKey } from './keys.mjs';
import { callModel, runGate, writeDiff, runProcess, changedFiles } from './runner.mjs';
import { estimateRemaining } from './cost.mjs';
import { fetchUsage, keyQuotaMap } from './usage.mjs';
import { readLedger, summarizeLedger } from './report.mjs';

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
  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  const out = await callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: ctx.config.roles.scout, apiKey: key?.value,
    systemPrompt: readAgent('scout'), prompt: workOrderText(task, { workdir: ctx.workdir }),
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, 'scout.json'), cwd: ctx.workdir, role: 'scout',
  });
  if (out.exhausted && key) ctx.keyState.exhausted.add(key.name);
  return { ...out, key };
}

export async function callVerifier(ctx, task, model, agentName, suffix, cycleDir) {
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
    verdict: (verdicts || []).some((v) => v.verdict !== 'PASS') ? 'FAIL' : 'PASS',
    findings: compactFindings(verdicts),
    acceptance,
    summary: extractSummary(authorText),
    diff: path.join(cycleDir, 'diff.patch'),
    gateLog: path.join(cycleDir, 'gate.log'),
  };
}

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
    state = { ...state, ...prev };
    if (prev.status === 'in-progress') log(`  resume desde ciclo ${state.cycle + 1} (costo previo $${state.spentUsd.toFixed(4)})`);
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
    state.scoutMap = (s.text || '').slice(0, 6000);
    recordUsage(state, s.usage);
    ledgerEntry(task, 0, 'scout', config.roles.scout, s.key, s);
    if (s.timedOut) warn('scout sin respuesta (timeout); sigo sin mapa de contexto');
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
    const authorOut = await callModel({
      runner: ctx.runner, pi: ctx.pi, provider: config.provider, model: author, apiKey: aKey?.value,
      systemPrompt: readAgent('author'),
      prompt: workOrderText(task, { workdir: ctx.workdir, scoutMap: state.scoutMap }),
      tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'], logFile: path.join(cycleDir, 'author.json'), cwd: ctx.workdir, role: 'author',
    });
    recordUsage(state, authorOut.usage);
    if (authorOut.exhausted && aKey) ctx.keyState.exhausted.add(aKey.name);
    lastAuthorText = authorOut.text || lastAuthorText;
    ledgerEntry(task, cycle, 'author', author, aKey, authorOut);

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

    // VERIFY
    if (ctx.runner === 'stub') fs.writeFileSync(path.join(cycleDir, 'diff.patch'), '');
    else await writeDiff(ctx.workdir, path.join(cycleDir, 'diff.patch'));
    const verdicts = [];
    let verifierTimedOut = false;
    const v1 = await callVerifier(ctx, task, verifier, 'verifier', 'a', cycleDir);
    recordUsage(state, v1.out.usage);
    ledgerEntry(task, cycle, 'verifier', verifier, v1.key, v1.out, { verdict: v1.verdict?.verdict ?? (v1.out?.timedOut ? 'UNKNOWN' : 'FAIL') });
    if (v1.out?.timedOut) { verifierTimedOut = true; warn(`  verifier ${verifier} sin respuesta (timeout) → reintento`); }
    verdicts.push(v1.verdict || { verdict: v1.out?.timedOut ? 'UNKNOWN' : 'FAIL', findings: [] });
    if (highRisk && config.loop.doubleVerifyHighRisk) {
      const second = config.roles.verifier.find((m) => m !== author && m !== verifier) || config.roles.verifier[0];
      const v2 = await callVerifier(ctx, task, second, 'verifier', 'b', cycleDir);
      recordUsage(state, v2.out.usage);
      ledgerEntry(task, cycle, 'verifier', second, v2.key, v2.out, { verdict: v2.verdict?.verdict ?? (v2.out?.timedOut ? 'UNKNOWN' : 'FAIL') });
      if (v2.out?.timedOut) verifierTimedOut = true;
      verdicts.push(v2.verdict || { verdict: v2.out?.timedOut ? 'UNKNOWN' : 'FAIL', findings: [] });
      const securityModel = config.roles.security || config.roles.verifier[0];
      const vs = await callVerifier(ctx, task, securityModel, 'security-reviewer', 'sec', cycleDir);
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

    const failed = verdicts.some((v) => v.verdict !== 'PASS' || (v.findings || []).some((f) => f.severity === 'high'));

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

export async function integrateTask(ctx, task, wt, commitMessage) {
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
      appendJsonl(LEDGER, { ts: now(), task: task.id, cycle: null, role: 'merge-agent', model: ctx.config.roles.merge, key: key?.name ?? null, cost: fix.usage?.cost || 0, turns: fix.usage?.turns || 0, exhausted: !!fix.exhausted, timedOut: !!fix.timedOut });
      await runProcess('git', ['add', '-A'], { cwd: ROOT });
      const mc = await runProcess('git', ['commit', '--no-edit'], { cwd: ROOT });
      if (mc.code === 0) return { ok: true, log: 'resuelto por merge-agent' };
    }
    await runProcess('git', ['merge', '--abort'], { cwd: ROOT });
    return { ok: false, conflict: true, log: m.out + m.err };
  });
}
