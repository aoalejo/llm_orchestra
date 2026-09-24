#!/usr/bin/env node
/**
 * Lean Orchestrator v2 — driver del loop Ralph con verificación adversa.
 *
 * Este archivo es sólo el entrypoint/CLI. La implementación vive en `lib/`:
 *   paths, log, util, agents, args, pure, stub, runner, worktrees, keys, loop,
 *   report, modelscmd y el ranking de modelos (models/rank/leaderboard).
 *
 * Invariante: workers/verifiers NO commitean. Solo el driver commitea EN NOMBRE
 * del orquestador, y únicamente tras su APPROVE.
 *
 * Sin dependencias externas.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { O, RUNS, SCRATCH, WORKTREES, ROOT, TEMPLATES_DIR } from './lib/paths.mjs';
import { flags, log, warn, die } from './lib/log.mjs';
import { ensureDir, readJson, writeJson, exists, now, makeQueue } from './lib/util.mjs';
import { parseArgs } from './lib/args.mjs';
import { loadEnv, readAgent } from './lib/agents.mjs';
import {
  extractLastJson, isProtected, isProtectedChange, findingsSignature, gateCommands,
  workOrderText, pickAuthorVerifier, pickFallbackPair, recordUsage, budgetStatus,
  shouldMetaReview, pathsConflict, detectExhausted, detectUnusableModel, blacklistModel, normalizeVerdict,
  normalizeWorkOrder, validateWorkOrder, compactFindings, slugify, changesScope, classifyExhaustion,
} from './lib/pure.mjs';
import { stubModel } from './lib/stub.mjs';
import { resolvePi, callModel, changedFiles, setPiTimeout, runProcess, streamPathFor, heartbeatPathFor, buildPiArgs, promptArgFor } from './lib/runner.mjs';
import { makeKeyState, pickKey, keysStatus, workerKeyEntries, workerKeyNames, parseKeyList, worstQuotaPct, orderPoolByQuota } from './lib/keys.mjs';
import { checkKeys } from './lib/keys-check.mjs';
import { prepareWorktree, removeWorktree, installSignalHandlers, resolveLinkTargets, cleanWorktrees } from './lib/worktrees.mjs';
import { runTaskLoop } from './lib/loop.mjs';
import { integrateTask } from './lib/integrate.mjs';
import { makeDeps, executeTask, scoutCommand, dispatchCommand, approveCommand, rejectCommand, statusCommand, usageCommand } from './lib/commands.mjs';
import { runWithConcurrency } from './lib/util.mjs';
import { runModelsCommand, applyAndSaveRanking } from './lib/modelscmd.mjs';
import { reportCommand, summarizeLedger } from './lib/report.mjs';
import { runDashboard, renderDashboard, renderDashboardPlain } from './lib/dashboard.mjs';
import { matchGlob, denyReadHit, denyCommandHit, extractPaths, lintAcceptance, exportGuards } from './lib/guards.mjs';
import { refreshRankings, rankingsStale, maxAgeHoursOf } from './lib/models.mjs';
import { rankModels, configPatchFromRanking, modelFamily, bestArenaMatch, idVariants } from './lib/rank.mjs';
import { matchModel } from './lib/leaderboard.mjs';
import { scoutCacheKey, socraticodeOptions, buildScoutPrompt, looksLikeMap } from './lib/scout.mjs';
import { parseUsage, quotaStatus } from './lib/usage.mjs';
import { estimateRemaining } from './lib/cost.mjs';

import { selfTest } from "./lib/selftest.mjs";
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


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Lean Orchestrator v2

  orchestra init [--force]          # scaffold .orchestra/ en el proyecto actual
  orchestra --self-test
  orchestra --keys-status
  orchestra --keys-check             # llamada real por key: cuál responde y cuál está agotada
  orchestra models [--apply] [--json] [--refresh]
                                    # ranking de modelos (opencode + arena.ai)
  orchestra report [--json]         # costos y veredictos desde ledger.jsonl
  orchestra --clean [--force]       # limpia worktrees/ramas huérfanas (deslinkea junctions)
  orchestra scout [--query "..."] [--task <id>] [--json]
                                    # recon barato (no gasta tu contexto)
  orchestra dispatch --order '<json>' [--order ...] [--workers N] [--commit] [--json]
                                    # 1..N work orders en paralelo → resumen compacto
  orchestra approve --task <id> [--commit] [--yes] [--message "..."]
  orchestra reject --task <id> [--reason "..."]
  orchestra status [--json]
  orchestra --plan                  # imprime STATE.md + backlog (sin LLM)
  orchestra --task <id> [--commit] [--yes] [--dry-run]
  orchestra --all [--workers 4] [--no-worktrees]

Flags: --plan --task <id> --all --commit --yes --dry-run --workers <n> --no-worktrees --verbose --self-test --keys-status --keys-check
       models [--apply] [--json] --stub  report [--json]  --clean [--force]
       scout|dispatch|approve|reject|status  --order <json> --orders <file> --decisions <json>`);
    return;
  }
  if (args.selfTest) return await selfTest();
  if (args.init) return initProject(args.force);

  if (!exists(path.join(O, 'config.json'))) die('falta .orchestra/config.json');
  let config = readJson(path.join(O, 'config.json'));
  flags.verbose = args.verbose;
  if (args.json) flags.quiet = true;   // sólo salida máquina en stdout
  setPiTimeout(config.loop?.piTimeoutMs);   // timeout de cada llamada a pi
  process.env.ORCHESTRA_ROOT = ROOT;        // para los guards de la extensión (T-05/T-12)
  process.env.ORCHESTRA_GUARDS = JSON.stringify(exportGuards(config) || {});
  loadEnv(path.join(O, '.env'));            // antes de resolvePi: ORCHESTRA_PI_CLI puede venir del .env
  ensureDir(RUNS); ensureDir(SCRATCH); ensureDir(WORKTREES);

  if (args.models) { if (args.json) flags.quiet = true; await runModelsCommand(args, config); return; }
  if (args.report) { if (args.json) flags.quiet = true; reportCommand(args); return; }
  if (args.dashboard) { await runDashboard(args, config); return; }
  if (args.clean) { await cleanWorktrees(config, { force: args.force }); return; }
  if (args.keysStatus) { log('estado de credenciales:'); keysStatus(config); return; }
  if (args.keysCheck) { await checkKeys(config, { cwd: ROOT }); return; }

  const runner = args.stub || process.env.ORCHESTRA_RUNNER === 'stub' ? 'stub' : 'real';
  const pi = runner === 'stub' ? { label: 'stub', command: 'stub', prefix: [], shell: false } : resolvePi(config);
  const tasksFile = path.join(O, 'tasks.json');
  const tasksDoc = readJson(tasksFile);

  log(`pi: ${pi.label} | provider: ${config.provider} | runner: ${runner}`);
  if (!process.env[config.keys.orchestrator]) warn(`falta ${config.keys.orchestrator} en .orchestra/.env`);
  if (!workerKeyEntries(config).length) warn(`falta alguna key de worker en ${workerKeyNames(config).join(', ') || '(config.keys.workers)'} (.orchestra/.env)`);
  if (args.decisionsRaw) {
    try { args.decisions = JSON.parse(args.decisionsRaw); } catch (e) { die(`--decisions no es JSON válido: ${e.message}`); }
  }

  // Subcomandos de modo chat (el orquestador sos vos).
  const needDeps = args.scout || args.dispatch || args.approve || args.reject;
  const cmdDeps = needDeps ? makeDeps(config, pi, runner) : null;
  if (args.scout) { await scoutCommand(args, config, cmdDeps); return; }
  if (args.dispatch) { await dispatchCommand(args, config, cmdDeps); return; }
  if (args.approve) { await approveCommand(args, config, cmdDeps); return; }
  if (args.reject) { await rejectCommand(args, config, cmdDeps); return; }
  if (args.status) { statusCommand(args, config); return; }
  if (args.usage) { await usageCommand(args, config); return; }

  if (args.plan) {
    // En modo chat el orquestador sos vos: no hay LLM de planificación interno.
    const state = fs.readFileSync(path.join(O, 'STATE.md'), 'utf8');
    const backlog = tasksDoc.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk }));
    console.log(JSON.stringify({ state, backlog }, null, 2));
    return;
  }

  // Rankings de modelos: refresh best-effort si están viejos (default: cada 24 h).
  if (runner === 'real' && config.models?.rankings?.enabled !== false && !args.plan) {
    try {
      const genPath = path.join(O, 'models.generated.json');
      const gen = exists(genPath) ? readJson(genPath) : null;
      const maxAgeHours = maxAgeHoursOf(config);
      if (args.refresh || rankingsStale(gen?.generatedAt, maxAgeHours)) {
        const ranking = await refreshRankings(config);
        writeJson(genPath, { generatedAt: now(), ...ranking });
        log(`rankings de modelos actualizados (cada ${maxAgeHours} h) → author: ${ranking.author.join(', ')}`);
        if (config.models?.rankings?.autoApply) {
          config = applyAndSaveRanking(config, ranking, path.join(O, 'config.json'));
          log('pools de rotación aplicados a config.json');
        }
      } else {
        const ageH = ((Date.now() - new Date(gen.generatedAt).getTime()) / 3600e3).toFixed(1);
        log(`rankings de modelos vigentes (${ageH} h; refresca a las ${maxAgeHours} h)`);
      }
    } catch (e) { warn(`no se pudo actualizar rankings: ${e.message}`); }
  }

  const pending = tasksDoc.tasks.filter((t) => t.status === 'pending' || t.status === 'in-progress');
  let selected;
  if (args.task) selected = [tasksDoc.tasks.find((t) => t.id === args.task)].filter(Boolean);
  else if (args.all) selected = pending;
  else selected = pending.slice(0, 1);
  if (!selected.length) { log('no hay tareas pendientes'); return; }

  const limit = args.noWorktrees ? 1 : (args.workers || config.loop.maxParallelTasks || 1);
  installSignalHandlers();   // Ctrl+C: limpiar worktrees a medio hacer
  const deps = makeDeps(config, pi, runner);
  deps.remainingTasks = selected.length;
  const results = [];

  await runWithConcurrency(selected, limit, async (task) => {
    log(`\n=== tarea ${task.id} (${task.risk}) — ${task.title} ===`);
    const r = await executeTask(deps, task, {
      autoApprove: !!args.commit, commit: !!args.commit, yes: args.yes, dryRun: args.dryRun, decisions: args.decisions,
    });
    log(`=== fin ${task.id} — ${r.status} — costo≈$${r.cost} — integración=${r.integration?.ok ? 'ok' : r.integration?.skipped ? 'dry' : 'falló'} ===`);
    results.push(r);
  });

  writeJson(path.join(RUNS, 'last-run.json'), { ts: now(), results: results.map((r) => ({ task: r.id, status: r.status, approved: !!r.approved, spentUsd: r.cost, integration: r.integration?.ok ?? null })) });
  log('\nresumen guardado en .orchestra/runs/last-run.json');
}

main().catch((e) => die(e?.stack || String(e)));
