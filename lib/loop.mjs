/** Loop Ralph por tarea: autor → gate → verifier → aprobación, e integración. */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RUNS, SCRATCH, LEDGER } from './paths.mjs';
import { ensureDir, exists, readJson, writeJson, appendJsonl, now } from './util.mjs';
import { log, warn } from './log.mjs';
import { readAgent } from './agents.mjs';
import {
  extractLastJson, findingsSignature, gateCommands, workOrderText,
  pickAuthorVerifier, pickFallbackPair, recordUsage, budgetStatus, shouldMetaReview,
} from './pure.mjs';
import { pickKey } from './keys.mjs';
import { callModel, runGate, writeDiff, runProcess } from './runner.mjs';

export async function callOrchestrator(ctx, instruction, logFile) {
  const rc = ctx.config.roles.orchestrator;
  const key = process.env[ctx.config.keys.orchestrator];
  return callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: rc.model, apiKey: key,
    systemPrompt: readAgent('orchestrator'), prompt: instruction, tools: ['read', 'grep', 'find', 'ls', 'bash'],
    thinking: rc.thinking, logFile, cwd: ROOT, role: 'orchestrator',
  });
}

export async function callScout(ctx, task, cycleDir) {
  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  return callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: ctx.config.roles.scout, apiKey: key?.value,
    systemPrompt: readAgent('scout'), prompt: workOrderText(task, { workdir: ctx.workdir }),
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, 'scout.json'), cwd: ctx.workdir, role: 'scout',
  });
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

export async function runTaskLoop(ctx, task, taskDir) {
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
    appendJsonl(LEDGER, { ts: now(), task: task.id, cycle, role: 'author', model: author, key: aKey?.name, cost: authorOut.usage?.cost || 0, turns: authorOut.usage?.turns || 0, exhausted: !!authorOut.exhausted, timedOut: !!authorOut.timedOut });

    // Timeout del autor → fallo reintentable: siguiente ciclo (no gasta verifier).
    if (authorOut.timedOut) {
      warn(`  autor ${author} sin respuesta (timeout); reintento en el próximo ciclo`);
      state.cycle = cycle;
      saveState();
      continue;
    }

    const budgetAfterAuthor = budgetStatus(config, state);
    if (!budgetAfterAuthor.ok) { warn(`presupuesto superado: ${budgetAfterAuthor.reason}`); state.status = 'blocked'; saveState(); return state; }

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
    const v1 = await callVerifier(ctx, task, verifier, 'verifier', 'a', cycleDir);
    if (v1.out?.timedOut) warn(`  verifier ${verifier} sin respuesta (timeout) → FAIL`);
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
    state.commitMessage = appr.commitMessage || `fix(${task.id}): ${task.title}`;
    saveState();
    return state;
  }

  state.status = 'failed';
  saveState();
  return state;
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
      await runProcess('git', ['add', '-A'], { cwd: ROOT });
      const mc = await runProcess('git', ['commit', '--no-edit'], { cwd: ROOT });
      if (mc.code === 0) return { ok: true, log: 'resuelto por merge-agent' };
    }
    await runProcess('git', ['merge', '--abort'], { cwd: ROOT });
    return { ok: false, conflict: true, log: m.out + m.err };
  });
}
