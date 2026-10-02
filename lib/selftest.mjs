/** Self-test de lógica pura (movido fuera del entrypoint). */
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { RUNS } from "./paths.mjs";
import { slugify, normalizeWorkOrder, validateWorkOrder, compactFindings, extractLastJson, findingsSignature, pathsConflict, isProtected, isProtectedChange, changesScope, gateCommands, workOrderText, pickAuthorVerifier, pickFallbackPair, recordUsage, budgetStatus, shouldMetaReview, detectExhausted, normalizeVerdict, detectUnusableModel, blacklistModel, classifyExhaustion, baselinePolicy, isTransportError, noUsableVerdict, continuationAddendum, splitModelRef, modelCallOpts, keysMode, isModelEvent } from "./pure.mjs";
import os from "node:os";
import { runProcess, streamPathFor, heartbeatPathFor, buildPiArgs, promptArgFor, resolvePi, shimTarget, descendantsOf, runPiResilient } from "./runner.mjs";
import { makeKeyState, parseKeyList, workerKeyEntries, pickKey, worstQuotaPct, orderPoolByQuota } from "./keys.mjs";
import { idVariants, modelFamily, bestArenaMatch, rankModels, configPatchFromRanking } from "./rank.mjs";
import { normalize, matchModel } from "./leaderboard.mjs";
import { summarizeLedger } from "./report.mjs";
import { rankingsStale, maxAgeHoursOf, fetchLiveModels, providerQueryAllowed } from "./models.mjs";
import { scoutCacheKey, socraticodeOptions, buildScoutPrompt, looksLikeMap } from "./scout.mjs";
import { parseUsage, quotaStatus, fetchUsage } from "./usage.mjs";
import { estimateRemaining } from "./cost.mjs";
import { exportGuards, matchGlob, denyReadHit, denyCommandHit, gitWriteHit, extractPaths, lintAcceptance, NO_SELF_COMMANDS, NO_SELF_TOOLS, allowReadOnlyApi } from "./guards.mjs";
import { renderDashboardPlain, renderDashboard } from "./dashboard.mjs";
import { resolveLinkTargets, inFlightReason, describeBusyReuse } from "./worktrees.mjs";
import { stubModel } from "./stub.mjs";
import { parseArgs } from "./args.mjs";
import { roleTail } from "./loop.mjs";
import { qaDiff } from "./verify.mjs";
import { unknownWithoutFindings } from "./pure.mjs";

export async function selfTest() {
  const t = [];
  const eq = (name, cond) => t.push({ name, ok: !!cond });
  eq('extractLastJson bloque ```json', extractLastJson('foo\n```json\n{"verdict":"PASS","findings":[]}\n```\nbar')?.verdict === 'PASS');
  eq('extractLastJson objeto balanceado', extractLastJson('bla {"a":{"b":1},"c":"}"} fin')?.a?.b === 1);
  eq('extractLastJson null', extractLastJson('sin json') === null);
  eq('findingsSignature estable', findingsSignature([{ findings: [{ file: 'a', line: 1 }] }]) === findingsSignature([{ findings: [{ file: 'a', line: 1 }] }]));
  eq('isProtected detecta scope', isProtected({ protectedPaths: ['apps/backend/src/paisanitos/orders/'] }, { scope: ['apps/backend/src/paisanitos/orders/orders.service.ts'] }) === true);
  eq('isProtected ignora ajeno', isProtected({ protectedPaths: ['apps/backend/src/paisanitos/orders/'] }, { scope: ['apps/mobile/src/App.tsx'] }) === false);
  // T-03(b): baseline rojo no se pelea a ciegas (corta en needs-decision, no quema ciclos).
  eq('baselinePolicy verde sigue', baselinePolicy({ ok: true }) === 'continue');
  eq('baselinePolicy rojo corta', baselinePolicy({ ok: false }) === 'abort');
  eq('baselinePolicy rojo + decision del orquestador sigue', baselinePolicy({ ok: false, decisions: { gate: 'continue' } }) === 'continue');
  eq('baselinePolicy rojo + allowRedBaseline sigue', baselinePolicy({ ok: false, gates: { allowRedBaseline: true } }) === 'continue');
  // Un 400 del proveedor NO es un veredicto: se reintenta sin perder el diff del autor.
  eq('isTransportError detecta 400', isTransportError({ stopReason: 'error', errorMessage: '400 event: error' }) === true);
  eq('isTransportError ignora un veredicto normal', isTransportError({ stopReason: 'stop', text: 'PASS' }) === false);
  eq('isTransportError no pisa el timeout (T-02)', isTransportError({ timedOut: true, errorMessage: 'x' }) === false);
  eq('noUsableVerdict cubre timeout y transporte', noUsableVerdict({ timedOut: true }) === true && noUsableVerdict({ errorMessage: '400' }) === true && noUsableVerdict({ stopReason: 'stop' }) === false);
  const wo = workOrderText({ id: 'x', title: 'T', risk: 'high', contractRef: '1', targets: ['backend'], scope: ['a.ts'], acceptance: ['pasa'] }, {});
  eq('workOrderText incluye acceptance', wo.includes('pasa') && wo.includes('a.ts'));
  eq('pickAuthorVerifier distintos', (() => { const c = { roles: { author: ['m1', 'm2'], verifier: ['m1', 'm2'] } }; const r = pickAuthorVerifier(c, 1, 4); return r.author !== r.verifier; })());
  // ADR 0005: sin escalado automático a modelos caros.
  eq('pickAuthorVerifier no escala solo (default)', (() => {
    const c = { roles: { author: ['a1', 'a2'], verifier: ['v1', 'v2'], escalationAuthor: 'caro', escalationVerifier: 'caro2' }, loop: {} };
    const r = pickAuthorVerifier(c, 4, 4);
    return r.author !== 'caro' && r.verifier !== 'caro2';
  })());
  eq('pickAuthorVerifier escala si autoEscalate', (() => {
    const c = { roles: { author: ['a1', 'a2'], verifier: ['v1', 'v2'], escalationAuthor: 'caro', escalationVerifier: 'caro2' }, loop: { autoEscalate: true } };
    const r = pickAuthorVerifier(c, 4, 4);
    return r.author === 'caro' && r.verifier === 'caro2' && r.last === true;
  })());

  eq('shouldMetaReview highRisk', shouldMetaReview({ metaReview: { enabled: true, alwaysForHighRisk: true } }, true) === true);
  eq('shouldMetaReview sample', shouldMetaReview({ metaReview: { enabled: true, sampleRate: 0 } }, false, () => 0.5) === false);
  eq('stub orchestrator APPROVE', JSON.parse(stubModel({ role: 'orchestrator', prompt: 'Aprobá' }).text).decision === 'APPROVE');
  eq('stub verifier PASS', JSON.parse(stubModel({ role: 'verifier', prompt: '' }).text).verdict === 'PASS');
  eq('pathsConflict raiz', pathsConflict('apps/x/', 'apps/x/y.ts') === true);
  eq('pathsConflict por segmentos (no falso positivo)', pathsConflict('apps/backend/src/orders', 'apps/backend/src/orders-v2/x.ts') === false);
  eq('pathsConflict prefijo real', pathsConflict('apps/backend/src/orders', 'apps/backend/src/orders/x.ts') === true);
  eq('pathsConflict distinto', pathsConflict('apps/mobile', 'apps/backend') === false);
  eq('detectExhausted ignora texto del modelo', detectExhausted({ stderr: '', text: 'el endpoint devuelve 402 Payment Required si no hay saldo' }) === false);
  // Mensaje real de opencode-go cuando la cuenta se queda sin saldo
  // (el 402 suele venir en el mismo string, pero no dependemos de eso).
  eq('detectExhausted "Insufficient account funds"', detectExhausted({ errorMessage: 'Upstream request failed: Insufficient account funds' }) === true);
  eq('detectExhausted "insufficient funds"', detectExhausted({ errorMessage: 'insufficient funds' }) === true);

  // Modelo que el workspace NO puede usar (privacidad del proveedor) → blacklist
  // automática: fuera del pool + models.exclude (persistente).
  const unusableMsg =
    'opencode-go API error (400): {"type":"server_error","message":"Upstream request failed: This Go model trains on request data. Allow paid endpoints that train on request data in your workspace\'s Privacy settings to use it."}';
  eq('detectUnusableModel detecta "trains on request data"', detectUnusableModel({ errorMessage: unusableMsg }) === true);
  eq('detectUnusableModel ignora un 429 normal', detectUnusableModel({ errorMessage: 'opencode-go API error (429): rate limit' }) === false);
  eq('detectUnusableModel ignora el texto del modelo', detectUnusableModel({ stderr: '', text: unusableMsg }) === false);
  eq('blacklistModel saca el modelo de todos los pools', (() => {
    const c = {
      roles: { author: ['malo', 'bueno'], verifier: ['malo', 'otro'], scout: 'malo', security: 'bueno', escalationAuthor: 'malo' },
      fallback: { models: ['fb'] },
      models: { exclude: [] },
    };
    const r = blacklistModel(c, 'malo', { reason: unusableMsg });
    return r.added === true
      && JSON.stringify(c.roles.author) === JSON.stringify(['bueno'])
      && JSON.stringify(c.roles.verifier) === JSON.stringify(['otro'])
      && c.roles.scout === 'bueno'
      && c.roles.escalationAuthor === 'bueno'
      && c.roles.security === 'bueno'
      && c.models.exclude.includes('malo')
      && typeof c.models.blacklistNotes.malo === 'string';
  })());
  eq('blacklistModel no duplica en exclude', (() => {
    const c = { roles: { author: ['malo'] }, models: { exclude: ['malo'] } };
    const r = blacklistModel(c, 'malo', {});
    return r.added === false && c.models.exclude.length === 1;
  })());

  // Línea de comandos de Windows: prompt inline o @archivo (evita el "too long").
  // Veredictos: los roles no siempre respetan PASS/FAIL (el security-reviewer
  // devolvió "approve"/"pass"/undefined y el loop marcaba FAIL siempre).
  eq('normalizeVerdict acepta sinónimos', ['PASS', 'pass', 'Approve', 'ok', 'approved'].every((v) => normalizeVerdict(v) === 'PASS'));
  eq('normalizeVerdict default seguro', [undefined, null, '', 'FAIL', 'reject'].every((v) => normalizeVerdict(v) === 'FAIL'));

  eq('promptArgFor inline si entra', promptArgFor(['--x'], 'corto', null, { shell: true }) === 'corto');
  eq('promptArgFor inline con 20k sin shell', promptArgFor(['--x'], 'a'.repeat(20000), null, { shell: false }) === 'a'.repeat(20000));
  eq('promptArgFor @archivo si no entra (shell)', (() => {
    const f = promptArgFor(['--x'], 'a'.repeat(20000), null, { shell: true, platform: 'win32' });   // el tope de 7000 es de cmd.exe: se fija la plataforma
    return f.startsWith('@') && fs.existsSync(f.slice(1));
  })());
  eq('detectExhausted detecta 429 en stderr', detectExhausted({ stderr: 'HTTP 429 Too Many Requests' }) === true);
  eq('detectExhausted detecta quota en errorMessage', detectExhausted({ errorMessage: 'Error: quota exceeded for this key' }) === true);
  eq('detectExhausted código de pagos no agota', detectExhausted({ stderr: 'ok', text: 'InsufficientFundsError: 402' }) === false);
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
  // P00096 D1: flags del comando verify.
  eq('parseArgs verify --worktree --base', (() => {
    const a = parseArgs(['verify', '--worktree', '/wt', '--base', 'main', '--order', '@o.json']);
    return a.verify === true && a.worktree === '/wt' && a.base === 'main' && a.order.length === 1;
  })());
  eq('gateCommands ignora $comment', (() => { const c = { gates: { $comment: 'no ejecutar', backend: ['a', 'b'] } }; return JSON.stringify(gateCommands(c, { targets: [] })) === JSON.stringify(['a', 'b']); })());
  eq('gateCommands respeta targets', (() => { const c = { gates: { backend: ['a'], mobile: ['m'] } }; return JSON.stringify(gateCommands(c, { targets: ['mobile'] })) === JSON.stringify(['m']); })());
  eq('matchModel exacto', matchModel('qwen3.8-max', [{ rank: 1, slug: 'qwen3.8-max', score: 100 }])?.variant === null);
  eq('matchModel variante', matchModel('deepseek-v4-flash', [{ rank: 1, slug: 'deepseek-v4-flash-high', score: 100 }])?.variant === 'high');
  eq('matchModel sin match', matchModel('no-existe', [{ rank: 1, slug: 'otro', score: 1 }]) === null);
  const rk = rankModels(
    [
      { id: 'cheap', cost: { input: 0.1, output: 0.2 }, contextWindow: 1000000 },
      { id: 'cheap2', cost: { input: 0.2, output: 0.4 }, contextWindow: 1000000 },
      { id: 'mid', cost: { input: 0.3, output: 0.6 }, contextWindow: 1000000 },
      { id: 'top', cost: { input: 2, output: 6 }, contextWindow: 1000000 },
    ],
    [
      { rank: 1, slug: 'top', score: 1700 },
      { rank: 2, slug: 'mid', score: 1600 },
      { rank: 3, slug: 'cheap', score: 1500 },
      { rank: 4, slug: 'cheap2', score: 1450 },
    ],
    { workerMaxInputCost: 0.5, workersPerRole: 2, fallbackCount: 1 },
  );
  eq('rankModels author por score', rk.author[0] === 'mid' && rk.author[1] === 'cheap');
  eq('rankModels verifier rota', rk.verifier[0] === 'cheap' && rk.verifier[1] === 'mid');
  eq('rankModels escalation top', rk.escalationAuthor === 'top' && rk.escalationVerifier === 'mid');
  eq('rankModels fallback barato', rk.fallback[0] === 'cheap2');
  eq('configPatchFromRanking', (() => { const p = configPatchFromRanking(rk); return p.roles.author.length === 2 && p.fallback.models[0] === 'cheap2'; })());
  eq('configPatchFromRanking roles de servicio', (() => {
    const p = configPatchFromRanking({ ...rk, service: 'mid' });
    return p.roles.scout === 'mid' && p.roles.scribe === 'mid' && p.roles.security === 'mid' && p.roles.merge === 'mid';
  })());
  eq('configPatchFromRanking serviceRoles off', (() => {
    const p = configPatchFromRanking({ ...rk, service: 'mid' }, { serviceRoles: false });
    return p.roles.scout === undefined;
  })());
  eq('rankModels service = mejor barato', rk.service === rk.author[0]);
  eq('modelFamily', modelFamily('mimo-v2.6-flash') === 'mimo' && modelFamily('qwen3.8-flash') === 'qwen');
  eq('bestArenaMatch alias', bestArenaMatch('qwen3.8-flash', [{ rank: 9, slug: 'qwen3.8-flash-next', score: 1636 }], { 'qwen3.8-flash': ['qwen3.8-flash-next'] })?.source === 'alias');
  eq('bestArenaMatch sin alias', bestArenaMatch('qwen3.8-max', [{ rank: 4, slug: 'qwen3.8-max', score: 1671 }], {})?.source === 'arena');
  eq('idVariants quita sufijos no semánticos', idVariants('muse-spark-1.2-contributor').join(',') === 'muse-spark-1.2-contributor,muse-spark-1.2');
  eq('idVariants no quita sufijos reales', idVariants('qwen3.8-flash').join(',') === 'qwen3.8-flash');
  eq('bestArenaMatch por sufijo -contributor', (() => {
    const m = bestArenaMatch('muse-spark-1.2-contributor', [{ rank: 35, slug: 'muse-spark-1.2 (xHigh)', score: 1534 }], {});
    return m?.score === 1534 && m.source === 'suffix';
  })());
  const rkFam = rankModels(
    [
      { id: 'mimo-v2.5', cost: { input: 0.14, output: 0.28 }, contextWindow: 1000000 },
      { id: 'mimo-v2.6-flash', cost: { input: 0.14, output: 0.28 }, contextWindow: 1000000 },
      { id: 'mimo-v2.9-max', cost: { input: 5, output: 15 }, contextWindow: 1000000 },
    ],
    [{ rank: 1, slug: 'mimo-v2.5', score: 1437 }, { rank: 2, slug: 'mimo-v2.9-max', score: 1700 }],
    { workerMaxInputCost: 0.5, workersPerRole: 2 },
  );
  const famEntry = rkFam.ranked.find((x) => x.id === 'mimo-v2.6-flash');
  eq('family hereda del hermano de costo parecido', famEntry?.source === 'family' && famEntry.score === Math.round(1437 * 0.95));
  const rkOv = rankModels([{ id: 'nuevo', cost: { input: 0.1, output: 0.2 }, contextWindow: 1000000 }], [],
    { scoreOverrides: { nuevo: { score: 1600, note: 'x' } }, workerMaxInputCost: 0.5, workersPerRole: 1 });
  eq('override manual gana', rkOv.ranked[0].source === 'override' && rkOv.ranked[0].score === 1600);
  const sum = summarizeLedger([
    { task: 't1', role: 'author', model: 'm1', cost: 0.1, turns: 3 },
    { task: 't1', role: 'verifier', model: 'm2', cost: 0.2, turns: 2 },
    { task: 't1', role: 'gate', ok: false },
    { task: 't2', role: 'author', model: 'm1', cost: 0.05, turns: 1, exhausted: true },
  ]);
  eq('summarizeLedger totales', sum.events === 4 && Math.abs(sum.cost - 0.35) < 1e-9 && sum.turns === 6 && sum.gateFails === 1 && sum.exhausted === 1);
  eq('summarizeLedger por modelo', sum.byModel.m1.calls === 2 && sum.byRole.verifier.calls === 1 && sum.byTask.t1.authorCycles === 1);
  eq('summarizeLedger vacío', summarizeLedger([]).events === 0 && summarizeLedger(null).cost === 0);
  eq('resolveLinkTargets default', resolveLinkTargets({}).length >= 1);
  eq('resolveLinkTargets custom', (() => { const t = resolveLinkTargets({ worktrees: { link: ['node_modules'] } }); return t.length === 1 && t[0].endsWith('node_modules'); })());
  eq('parseKeyList single', JSON.stringify(parseKeyList('abc')) === JSON.stringify(['abc']));
  eq('parseKeyList json', JSON.stringify(parseKeyList('["a","b"]')) === JSON.stringify(['a', 'b']));
  eq('parseKeyList separadores', JSON.stringify(parseKeyList('a, b\nc;d')) === JSON.stringify(['a', 'b', 'c', 'd']));
  eq('parseKeyList vacío', parseKeyList('   ').length === 0);
  eq('maxAgeHoursOf default y legacy', maxAgeHoursOf({}) === 24 && maxAgeHoursOf({ models: { rankings: { maxAgeDays: 3 } } }) === 72 && maxAgeHoursOf({ models: { rankings: { maxAgeHours: 5 } } }) === 5);
  eq('rankingsStale por horas', rankingsStale(new Date(Date.now() - 25 * 3600e3).toISOString(), 24) === true && rankingsStale(new Date(Date.now() - 3600e3).toISOString(), 24) === false);
  eq('workerKeyEntries expande lista y rota', (() => {
    const prev = process.env.ORCHESTRA_TEST_KEYS;
    process.env.ORCHESTRA_TEST_KEYS = 'k1,k2,k3';
    const cfg = { keys: { orchestrator: 'ORCHESTRA_TEST_ORCH', workers: 'ORCHESTRA_TEST_KEYS' } };
    const entries = workerKeyEntries(cfg);
    const ks = makeKeyState();
    const p1 = pickKey(cfg, ks, 'worker');
    const p2 = pickKey(cfg, ks, 'worker');
    const ok = entries.length === 3 && p1.value === 'k1' && p2.value === 'k2' && p1.name === 'ORCHESTRA_TEST_KEYS#0';
    if (prev === undefined) delete process.env.ORCHESTRA_TEST_KEYS; else process.env.ORCHESTRA_TEST_KEYS = prev;
    return ok;
  })());
  eq('workerKeyEntries legacy array de env vars', (() => {
    const prev1 = process.env.ORCHESTRA_TEST_A; const prev2 = process.env.ORCHESTRA_TEST_B;
    process.env.ORCHESTRA_TEST_A = '["x","y"]'; process.env.ORCHESTRA_TEST_B = 'z';
    const cfg = { keys: { orchestrator: 'ORCHESTRA_TEST_ORCH', workers: ['ORCHESTRA_TEST_A', 'ORCHESTRA_TEST_B'] } };
    const names = workerKeyEntries(cfg).map((k) => k.name);
    const ok = names.join(',') === 'ORCHESTRA_TEST_A#0,ORCHESTRA_TEST_A#1,ORCHESTRA_TEST_B#0';
    if (prev1 === undefined) delete process.env.ORCHESTRA_TEST_A; else process.env.ORCHESTRA_TEST_A = prev1;
    if (prev2 === undefined) delete process.env.ORCHESTRA_TEST_B; else process.env.ORCHESTRA_TEST_B = prev2;
    return ok;
  })());
  eq('rankModels exclude', (() => {
    const r = rankModels(
      [{ id: 'a', cost: { input: 0.1, output: 0.2 } }, { id: 'b', cost: { input: 0.1, output: 0.2 } }],
      [{ rank: 1, slug: 'a', score: 100 }, { rank: 2, slug: 'b', score: 99 }],
      { exclude: ['a'], workerMaxInputCost: 1, workersPerRole: 1 },
    );
    return r.author[0] === 'b' && r.counts.excluded === 1;
  })());
  eq('rankModels pins por rol', (() => {
    const r = rankModels(
      [{ id: 'a', cost: { input: 0.1, output: 0.2 } }, { id: 'b', cost: { input: 0.1, output: 0.2 } }],
      [{ rank: 1, slug: 'a', score: 100 }, { rank: 2, slug: 'b', score: 99 }],
      { pins: { author: ['b'], service: 'a', security: 'b' }, workerMaxInputCost: 1, workersPerRole: 2 },
    );
    return r.author[0] === 'b' && r.service === 'a' && r.serviceRoles.security === 'b' && r.serviceRoles.scout === 'a';
  })());

  eq('streamPathFor', streamPathFor(path.join(RUNS, 't', 'cycle-1', 'author.json')).endsWith('author.stream.jsonl'));
  eq('heartbeatPathFor tarea', heartbeatPathFor(path.join(RUNS, 't', 'cycle-1', 'author.json')) === path.join(RUNS, 't', 'heartbeat.json'));
  eq('heartbeatPathFor global', heartbeatPathFor(path.join(RUNS, 'plan.orchestrator.json')) === path.join(RUNS, 'heartbeat.json'));
  const to = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400 });
  eq('runProcess timeout → timedOut y code 124', to.timedOut === true && to.code === 124);
  eq('slugify', slugify('Arreglar Login!!') === 'arreglar-login');
  eq('normalizeWorkOrder inline', (() => {
    const w = normalizeWorkOrder({ goal: 'arreglar login', acceptance: 'pasa el test', scope: 'src/a.js, src/b.js', risk: 'high' }, {});
    return w.id === 'arreglar-login' && w.acceptance.length === 1 && w.scope.length === 2 && w.risk === 'high';
  })());
  eq('normalizeWorkOrder desde task', (() => {
    const w = normalizeWorkOrder({ taskId: 'x' }, { id: 'x', title: 'T', acceptance: ['a'] });
    return w.id === 'x' && w.title === 'T' && w.acceptance[0] === 'a';
  })());
  eq('validateWorkOrder exige acceptance', validateWorkOrder({ id: 'a', title: 'b', acceptance: [] }).some((e) => /acceptance/.test(e)));
  eq('validateWorkOrder ok', validateWorkOrder({ id: 'a', title: 'b', acceptance: ['c'] }).length === 0);
  eq('compactFindings filtra low', compactFindings([{ findings: [{ severity: 'low', file: 'a' }, { severity: 'high', file: 'b', line: 3, problem: 'x' }] }]).length === 1);
  eq('scoutCacheKey estable y sensible a query', (() => {
    const a = scoutCacheKey({ head: 'h', provider: 'llm', query: 'a', scope: [], projectPath: 'p' });
    const b = scoutCacheKey({ head: 'h', provider: 'llm', query: 'a', scope: [], projectPath: 'p' });
    const c = scoutCacheKey({ head: 'h', provider: 'llm', query: 'b', scope: [], projectPath: 'p' });
    return a === b && a !== c;
  })());
  eq('socraticodeOptions defaults', (() => {
    const o = socraticodeOptions({});
    return o.command === 'npx' && o.limit === 8 && o.synthesize === true && !o.projectPath.includes('\\');
  })());
  eq('socraticodeOptions override', (() => {
    const o = socraticodeOptions({ scout: { socraticode: { command: 'node', args: ['x.js'], limit: 3, synthesize: false } } });
    return o.command === 'node' && o.args[0] === 'x.js' && o.limit === 3 && o.synthesize === false;
  })());
  eq('buildScoutPrompt inyecta chunks', (() => {
    const p = buildScoutPrompt({ query: 'q', scope: ['src'], task: { acceptance: ['c'] }, external: { ok: true, chunks: 'CHUNK' } });
    return p.includes('CHUNK') && p.includes('src') && p.includes('c');
  })());
  eq('parseUsage normaliza', (() => {
    const u = parseUsage({ usage: { rolling: { percent: 4, resetsAt: 'x' }, weekly: { percent: 1 }, monthly: { percent: 0 } } });
    return u.rolling.percent === 4 && u.weekly.percent === 1 && u.monthly.percent === 0 && u.rolling.resetsAt === 'x';
  })());
  eq('quotaStatus low', quotaStatus({ rolling: { percent: 96 }, weekly: { percent: 10 } }, 80) === 'low');
  eq('quotaStatus ok/unknown', quotaStatus({ rolling: { percent: 10 } }, 80) === 'ok' && quotaStatus(null) === 'unknown');
  eq('estimateRemaining por tarea', (() => {
    const e = estimateRemaining({ summary: { byTask: { t1: { cost: 0.2 }, t2: { cost: 0.4 } } }, remainingTasks: 3 });
    return Math.abs(e.perTaskUsd - 0.3) < 1e-9 && Math.abs(e.usd - 0.9) < 1e-9 && e.source === 'ledger/avgPerTask';
  })());
  eq('estimateRemaining sin datos', estimateRemaining({ summary: {}, remainingTasks: 2 }).usd === null);
  eq('renderDashboardPlain compacto', (() => {
    const data = { summary: { cost: 1.5, events: 3, gateFails: 1, exhausted: 0 }, tasks: [{ id: 't1', status: 'approved', cost: 0.3, approved: true }], usage: [{ role: 'orchestrator', name: 'A', usage: { rolling: { percent: 4 }, weekly: { percent: 1 } } }] };
    const l = renderDashboardPlain(data);
    return l.length >= 2 && l[0].includes('orchestra') && l.join(' ').includes('A:r4%');
  })());
  eq('renderDashboard frame', (() => {
    const data = { ts: 'now', summary: { cost: 0, byRole: { author: { calls: 1, cost: 0.1 } } }, tasks: [{ id: 't1', status: 'needs-approval', cycle: 2, cost: 0.1, decision: { reason: 'keys-exhausted' } }], usage: [], worktrees: [], branches: [], models: null, maxAgeHours: 24 };
    const f = renderDashboard(data).join('\n');
    return f.includes('POR ROL') && f.includes('t1') && f.includes('keys-exhausted');
  })());
  eq('buildPiArgs usa --session-dir (T-09)', (() => {
    const { args, sessionDir } = buildPiArgs({ provider: 'p', prompt: 'x', logFile: path.join('a', 'b', 'author.json'), role: 'author' });
    return args.includes('--session-dir') && !args.includes('--no-session') && sessionDir.replace(/\\/g, '/').endsWith('a/b/sessions/author');
  })());
  eq('buildPiArgs noSession', buildPiArgs({ provider: 'p', prompt: 'x', noSession: true, logFile: path.join('a', 'b', 'x.json'), role: 'x' }).args.includes('--no-session'));
  eq('changesScope (T-11)', changesScope(['src/a.ts'], ['src/']) === true && changesScope(['docs/x.md'], ['src/']) === false && changesScope([], ['src/']) === false && changesScope(['x'], []) === true);
  // Un UNKNOWN sin findings no es un FAIL: el verifier no decidió y el trabajo del author no se tira.
  eq('unknownWithoutFindings: UNKNOWN sin findings se rescata', unknownWithoutFindings([{ verdict: 'UNKNOWN', findings: [] }]) === true);
  eq('unknownWithoutFindings: PASS y FAIL no', unknownWithoutFindings([{ verdict: 'PASS', findings: [] }]) === false && unknownWithoutFindings([{ verdict: 'FAIL', findings: [] }]) === false);
  eq('unknownWithoutFindings: con findings no', unknownWithoutFindings([{ verdict: 'UNKNOWN', findings: [{ file: 'a', severity: 'low' }] }]) === false && unknownWithoutFindings([]) === false);

  // Presupuesto del verifier (0018): el timeout viaja por rol desde el config; sin la clave,
  // runner cae en PI_TIMEOUT_MS (ctx.timeoutMs ?? ...), así que el default no cambia.
  eq('callVerifier pasa el timeout por ctx', fs.readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8')
    .includes('timeoutMs: ctx.config.loop?.verifierTimeoutMs'));

  // P00096 D2: la guarda de permisos compara los snapshots de `git status` antes/después del
  // verifier: sólo lo que ÉL tocó es violación (y se revierte); `zz-qa-*` está permitido.
  eq('qaDiff: sólo lo que cambió es violación y zz-qa-* se conserva', (() => {
    const d = qaDiff({ 'README.md': 'h1', 'clean.js': 'h2' },
      { 'README.md': 'h1', 'clean.js': 'h3', 'foo.ts': 'n1', 'zz-qa-bar.test.ts': 'n2' });
    return d.violations.slice().sort().join(',') === 'clean.js,foo.ts'
      && d.kept.join(',') === 'zz-qa-bar.test.ts'
      && !d.touched.includes('README.md');
  })());
  eq('qaDiff: un borrado del verifier es violación', qaDiff({ 'a.js': 'x' }, {}).violations.join(',') === 'a.js');
  eq('qaDiff: la zona de scratch no es violación', qaDiff({}, { '.orchestra/scratch/t.js': 'x' }).violations.length === 0);

  // Timeout del author: la reanudación en frío tiene que mandarlo a mirar el diff antes de escribir.
  eq('continuationAddendum marca la continuación', /CONTINUACIÓN/.test(continuationAddendum()) && /git diff/.test(continuationAddendum()));
  // La decisión del timeout se informa con el heartbeat (silencio + modelo) y la cola del stream del
  // rol: sin eso el orquestador decide a ciegas sobre un archivo de 10 MB.
  { const d = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'orch-tail-'));
    fs.writeFileSync(path.join(d, 'heartbeat.json'), JSON.stringify({ silentMs: 1234, model: 'm1' }));
    fs.writeFileSync(path.join(d, 'author.stream.jsonl'),
      Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'message', text: `linea ${i}` })).join('\n'));
    const t = roleTail(d, d, 'author');
    eq('roleTail: heartbeat + últimas N líneas del stream',
       t.silentMs === 1234 && t.model === 'm1' && t.lines.length === 12 && /linea 19/.test(t.lines[11]));
    const vacio = roleTail(path.join(d, 'no-existe'), path.join(d, 'no-existe'), 'author');
    eq('roleTail sin heartbeat ni stream no rompe', vacio.silentMs === null && Array.isArray(vacio.lines) && vacio.lines.length === 0);
    fs.rmSync(d, { recursive: true, force: true }); }
  eq('worstQuotaPct (T-07)', worstQuotaPct({ rolling: { percent: 10 }, monthly: { percent: 95 } }) === 95 && worstQuotaPct(null) === 0);
  eq('orderPoolByQuota (T-07)', (() => {
    const pool = [{ value: 'k1' }, { value: 'k2' }, { value: 'k3' }];
    const q = { k1: { monthly: { percent: 50 } }, k2: { monthly: { percent: 10 } }, k3: { monthly: { percent: 99 } } };
    const r = orderPoolByQuota(pool, q, 95).map((x) => x.value);
    return r[0] === 'k2' && !r.includes('k3');
  })());
  eq('matchGlob **/.env', matchGlob('a/.env', '**/.env') === true && matchGlob('.env', '**/.env') === true);
  eq('matchGlob .orchestra/.env', matchGlob('.orchestra/.env', '.orchestra/.env') === true && matchGlob('.orchestra/config.json', '.orchestra/.env') === false);
  eq('denyReadHit (T-05)', denyReadHit('x/y.pem', ['**/*.pem']) === true && denyReadHit('src/a.ts', ['**/*.pem']) === false);
  eq('denyCommandHit (T-12)', denyCommandHit('docker compose restart api', ['docker\\s+compose\\s+(up|down|restart|stop)']) === true && denyCommandHit('npm test', ['taskkill']) === false);
  // T-13: un subagente (o un pi despertado por un wake) no dispara más subagentes ni agendarse wakes.
  eq('NO_SELF_COMMANDS bloquea dispatch/--task/bare y los endpoints que disparan agentes',
     denyCommandHit('node F:/Proyectos/orchestra/orchestra.mjs dispatch --order x', NO_SELF_COMMANDS) === true &&
     denyCommandHit('node orchestra.mjs --task subagentes-vivas --commit', NO_SELF_COMMANDS) === true &&
     denyCommandHit('cd F:/Proyectos/orchestra && node orchestra.mjs', NO_SELF_COMMANDS) === true &&
     denyCommandHit('curl -sX POST http://100.92.24.0:8110/api/wake?in=60&msg=x', NO_SELF_COMMANDS) === true &&
     denyCommandHit('curl -sX POST http://100.92.24.0:8110/api/jobs -d @jobs.json', NO_SELF_COMMANDS) === true &&
     denyCommandHit('curl -sX POST http://100.92.24.0:8110/api/sessions -d {}', NO_SELF_COMMANDS) === true &&
     denyCommandHit('curl -s http://100.92.24.0:8110/api/wake/tick', NO_SELF_COMMANDS) === true);
  // Borrar un wake PUNTUAL si se permite: es limpieza, y sin eso un monitor no puede apagarse solo.
  eq('NO_SELF_COMMANDS deja borrar un wake puntual',
     denyCommandHit('curl -s -X DELETE http://100.92.24.0:8110/api/wake/wake-14d12d8a', NO_SELF_COMMANDS) === false &&
     denyCommandHit('curl -X DELETE http://x/api/wake/wake-abc123', NO_SELF_COMMANDS) === false);
  // Ticket 0066: un commit del agente deja el worktree limpio y el loop lee "diff vacío" → FAIL espurio.
  eq('NO_SELF_COMMANDS bloquea las escrituras de git (y deja leer el repo)',
     denyCommandHit('git commit -m "feat: x"', NO_SELF_COMMANDS) === true &&
     denyCommandHit('cd F:/Proyectos/pi-web && git add -A', NO_SELF_COMMANDS) === true &&
     denyCommandHit('git -C .orchestra/worktrees/t push origin master', NO_SELF_COMMANDS) === true &&
     denyCommandHit('git merge --no-ff orchestra/x', NO_SELF_COMMANDS) === true &&
     denyCommandHit('git checkout -- jobs.json', NO_SELF_COMMANDS) === true &&
     denyCommandHit('git stash', NO_SELF_COMMANDS) === true &&
     denyCommandHit('git status --short && git diff --stat', NO_SELF_COMMANDS) === false &&
     denyCommandHit('git log --oneline -5 && git show HEAD:jobs.json', NO_SELF_COMMANDS) === false &&
     denyCommandHit('git rev-parse --abbrev-ref HEAD && git branch', NO_SELF_COMMANDS) === false &&
     denyCommandHit('gitWriteHit con -C: ' + gitWriteHit('git -C /tmp/x commit -m y'), NO_SELF_COMMANDS) === false);
  eq('NO_SELF_COMMANDS deja pasar --self-test y lo inofensivo',
     denyCommandHit('node orchestra.mjs --self-test', NO_SELF_COMMANDS) === false &&
     denyCommandHit('node orchestra.mjs models --refresh', NO_SELF_COMMANDS) === false &&
     denyCommandHit('git log --oneline', NO_SELF_COMMANDS) === false);
  // C del 0034: mirar el estado de las sesiones es diagnóstico, no disparar un agente. El curl de
  // lectura pasa; el mismo endpoint por POST (o con body) sigue bloqueado.
  eq('0034/C: el curl de LECTURA sobre api/sessions pasa, el de escritura no',
     allowReadOnlyApi('curl -s http://100.92.24.0:8110/api/sessions') === true &&
     allowReadOnlyApi('curl -s "http://x/api/sessions?path=F:\\x"') === true &&
     allowReadOnlyApi('curl -sX POST http://x/api/sessions -d {}') === false &&
     allowReadOnlyApi('curl -s --data @x.json http://x/api/sessions') === false &&
     allowReadOnlyApi('curl -s -F file=@a.png http://x/api/sessions') === false &&
     allowReadOnlyApi('curl -s http://x/api/jobs') === false &&
     denyCommandHit('curl -s http://100.92.24.0:8110/api/sessions', NO_SELF_COMMANDS) === true);
  // D del 0034: las tools de pi no pasan por `bash`, así que se bloquean por nombre.
  eq('0034/D: las tools que disparan o integran trabajo están en NO_SELF_TOOLS',
     ['orchestra_dispatch', 'orchestra_approve', 'orchestra_reject'].every((t) => NO_SELF_TOOLS.includes(t)) &&
     !NO_SELF_TOOLS.includes('orchestra_status') && !NO_SELF_TOOLS.includes('orchestra_scout'));
  eq('exportGuards expone el flag noSelfOrchestration',
     exportGuards({ guards: { noSelfOrchestration: true } }).noSelfOrchestration === true &&
     exportGuards({ guards: {} }).noSelfOrchestration === false);
  eq('exportGuards defaults/off', exportGuards({}).denyRead.length > 0 && exportGuards({ guards: { enabled: false } }) === null);
  eq('extractPaths', extractPaths('correr contra lab/proto/proto.db y listo').includes('lab/proto/proto.db'));
  eq('lintAcceptance (T-08)', (() => {
    const r = lintAcceptance({ task: { acceptance: ['correr lab/proto/proto.db'] }, protectedPaths: [], isIgnored: (p) => p.includes('proto.db'), exists: () => true });
    return r.warnings.some((w) => /ignorada/.test(w));
  })());
  eq('classifyExhaustion fondos/cuota/auth (T-06)', classifyExhaustion({ errorMessage: '402 Insufficient account funds' }) === 'funds' && classifyExhaustion({ stderr: '429 Too Many Requests' }) === 'quota' && classifyExhaustion({ stderr: '401 Unauthorized' }) === 'auth' && classifyExhaustion({ stderr: 'ok' }) === null);
  eq('looksLikeMap (T-10)', looksLikeMap('- lib/rank.mjs:12 — arma pools') === true && looksLikeMap('I need to look at the header structure then add a GET endpoint') === false);

  // 0057/0068/0077 de pi-web: pi sin shell en Windows, procesos huérfanos del run, worktree ocupado, --clean con runs en vuelo.
  eq('shimTarget saca el cli.js del shim de npm (barras de Windows o de posix)', [String.fromCharCode(92), '/'].every((sep) => shimTarget('endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%' + sep + ['node_modules', '@x', 'pi', 'cli.js'].join(sep) + '" %*', 'base') === path.join('base', 'node_modules', '@x', 'pi', 'cli.js')));
  eq('shimTarget null si no hay .js', shimTarget('@echo off', 'C:\n') === null);
  await (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pi-'));
    const js = path.join(tmp, 'node_modules', 'pi', 'cli.js');
    fs.mkdirSync(path.dirname(js), { recursive: true }); fs.writeFileSync(js, '');
    fs.writeFileSync(path.join(tmp, 'pi.cmd'), '"%_prog%"  "%dp0%/node_modules/pi/cli.js" %*');
    const r = resolvePi({}, { platform: 'win32', env: { PATH: tmp } });
    eq('resolvePi win32: el shim pi.cmd se lanza SIN shell (cmd.exe partía el prompt y cortaba en el salto de línea)', r.shell === false && r.prefix[0] === js);
    const none = resolvePi({}, { platform: 'win32', env: { PATH: os.tmpdir() + path.sep + 'no-existe-orch' } });
    eq('resolvePi win32 sin shim cae al shell', none.shell === true && none.command === 'pi.cmd');
    eq('resolvePi linux usa pi', resolvePi({}, { platform: 'linux', env: {} }).command === 'pi');
    fs.rmSync(tmp, { recursive: true, force: true });
  })();
  eq('descendantsOf sigue la cadena aunque el padre haya muerto y respeta notBefore/self', (() => {
    const procs = [{ pid: 2, ppid: 1, created: 100 }, { pid: 3, ppid: 2, created: 110 }, { pid: 9, ppid: 1, created: 10 }, { pid: 5, ppid: 99, created: 120 }, { pid: 7, ppid: 3, created: 130 }];
    return descendantsOf(1, procs, 50, 7).map((p) => p.pid).sort().join() === '2,3';
  })());
  await (async () => {
    // En POSIX sin `detached`: como el server de prueba que el author lanza desde el bash de pi (queda en el grupo del run). En Windows un hijo
    // no-detached muere con su padre, así que ahí se lo desprende para que sobreviva (es el caso que deja el cwd tomado).
    const parent = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform==='win32',stdio:'ignore'});console.log(c.pid);c.unref();";
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const off = await runProcess(process.execPath, ['-e', parent], {});
    const on = await runProcess(process.execPath, ['-e', parent], { reap: true });
    await new Promise((r) => setTimeout(r, 1200));
    const pOff = Number(off.out.trim()), pOn = Number(on.out.trim());
    eq('runProcess reap:true mata al nieto huérfano (server de prueba/sonda) y reap:false lo deja', alive(pOff) === true && alive(pOn) === false && on.reaped >= 1);
    try { process.kill(pOff); } catch { /* ya */ }
  })();
  eq('describeBusyReuse: EBUSY con .git se reusa; sin .git o con otro error no', (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-'));
    const sin = describeBusyReuse(d, { code: 'EBUSY' });
    fs.writeFileSync(path.join(d, '.git'), 'gitdir: x');
    const con = describeBusyReuse(d, { code: 'EBUSY' });
    const otro = describeBusyReuse(d, { code: 'ENOENT' });
    fs.rmSync(d, { recursive: true, force: true });
    return sin === null && con?.kind === 'worktree-reusado-por-ocupado' && con.error === 'EBUSY' && otro === null;
  })());
  eq('inFlightReason: lote running con pid vivo / latido reciente; muertos o viejos no', (() => {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-runs-'));
    const w = (f, o) => { fs.mkdirSync(path.dirname(path.join(runs, f)), { recursive: true }); fs.writeFileSync(path.join(runs, f), JSON.stringify(o)); };
    w('batch-a.json', { runId: 'batch-a', pid: 111, status: 'running', orders: ['tarea-a'] });
    w('batch-b.json', { runId: 'batch-b', pid: 222, status: 'done', orders: ['tarea-b'] });
    w('tarea-c/heartbeat.json', { ts: new Date(1000000).toISOString(), pid: 333 });
    const vivo = (pid) => pid !== 999;
    const o = { runs, alive: vivo, nowMs: 1000000 + 30000 };
    const r = [inFlightReason('tarea-a', o), inFlightReason('tarea-a', { ...o, alive: () => false }), inFlightReason('tarea-b', o), inFlightReason('tarea-c', o), inFlightReason('tarea-c', { ...o, nowMs: 1000000 + 10 * 60 * 1000 }), inFlightReason('tarea-x', o)];
    fs.rmSync(runs, { recursive: true, force: true });
    return /lote batch-a/.test(r[0]) && r[1] === null && r[2] === null && /latido/.test(r[3]) && r[4] === null && r[5] === null;
  })());

  // ── P00095: proveedor por rol, credenciales de pi, 429/402/cola colgada ──
  eq('splitModelRef: "deepseek/deepseek-flash" → provider deepseek + modelo deepseek-flash', (() => { const r = splitModelRef('deepseek/deepseek-flash', 'opencode-go'); return r.provider === 'deepseek' && r.model === 'deepseek-flash'; })());
  eq('splitModelRef: sin prefijo usa config.provider', (() => { const r = splitModelRef('mimo-v2.6-flash', 'opencode-go'); return r.provider === 'opencode-go' && r.model === 'mimo-v2.6-flash'; })());
  eq('splitModelRef: sólo la primera "/" separa (openrouter/qwen/qwen3-coder)', (() => { const r = splitModelRef('openrouter/qwen/qwen3-coder', 'x'); return r.provider === 'openrouter' && r.model === 'qwen/qwen3-coder'; })());
  eq('splitModelRef: un prefijo que no parece provider (con punto) no parte', splitModelRef('qwen3.8/flash', 'p').provider === 'p');
  eq('modelCallOpts: el provider/modelo viajan separados a --provider/--model', (() => {
    const o = modelCallOpts({ provider: 'opencode-go' }, 'deepseek/deepseek-flash');
    const { args } = buildPiArgs({ ...o, prompt: 'x', logFile: path.join('a', 'b', 'author.json'), role: 'author' });
    return args[args.indexOf('--provider') + 1] === 'deepseek' && args[args.indexOf('--model') + 1] === 'deepseek-flash';
  })());
  eq('modelCallOpts: sin prefijo → --provider config.provider (compatibilidad)', (() => {
    const o = modelCallOpts({ provider: 'opencode-go' }, 'qwen3.8-flash');
    const { args } = buildPiArgs({ ...o, apiKey: 'k', prompt: 'x', logFile: path.join('a', 'b', 'author.json'), role: 'author' });
    return args[args.indexOf('--provider') + 1] === 'opencode-go' && args[args.indexOf('--model') + 1] === 'qwen3.8-flash' && args[args.indexOf('--api-key') + 1] === 'k';
  })());
  eq('modelCallOpts: la key del pool NO viaja a un modelo de otro provider', (() => {
    const o = modelCallOpts({ provider: 'opencode-go' }, 'deepseek/deepseek-flash');
    return !buildPiArgs({ ...o, apiKey: 'secreta', prompt: 'x', logFile: path.join('a', 'b', 'x.json'), role: 'x' }).args.includes('--api-key');
  })());
  eq('modelCallOpts: defaults de backoff (30s/120s/300s) y firstTokenTimeoutMs (5 min); se pueden bajar por config', (() => {
    const d = modelCallOpts({}, 'm');
    const c = modelCallOpts({ keys: { retryBackoffMs: [5] }, loop: { firstTokenTimeoutMs: 1000 } }, 'm');
    return d.retryBackoffMs.join() === '30000,120000,300000' && d.firstTokenTimeoutMs === 300000 && c.retryBackoffMs.join() === '5' && c.firstTokenTimeoutMs === 1000;
  })());
  eq('pickAuthorVerifier (D8): compara provider/modelo — "m" y "deepseek/m" son el mismo si el default es deepseek', (() => {
    const c = { provider: 'deepseek', roles: { author: ['deepseek/m'], verifier: ['m', 'xiaomi/m'] } };
    return pickAuthorVerifier(c, 1, 4).verifier === 'xiaomi/m';
  })());
  eq('pickAuthorVerifier (D8): mismo id en providers distintos NO choca', (() => {
    const c = { provider: 'p', roles: { author: ['a/mimo'], verifier: ['b/mimo'] } };
    return pickAuthorVerifier(c, 1, 4).verifier === 'b/mimo';
  })());
  eq('pickFallbackPair compara provider/modelo', (() => { const p = pickFallbackPair({ provider: 'd', fallback: { models: ['d/m', 'm', 'x/m'] } }, 1); return p.author === 'd/m' && p.verifier === 'x/m'; })());
  eq('keysMode: ausente → pool; pi-auth sólo si se pide', keysMode({}) === 'pool' && keysMode({ keys: { mode: 'pool' } }) === 'pool' && keysMode({ keys: { mode: 'pi-auth' } }) === 'pi-auth');
  eq('pi-auth: pickKey no devuelve valor de key (aunque haya env vars) y nunca se agota', (() => {
    const cfg = { keys: { mode: 'pi-auth', orchestrator: 'ORCH_PIAUTH_TEST', workers: 'WORKERS_PIAUTH_TEST' } };
    process.env.ORCH_PIAUTH_TEST = 'orch-secret'; process.env.WORKERS_PIAUTH_TEST = 'w1,w2';
    const ks = makeKeyState(); ks.exhausted.add('pi-auth');
    const k = [pickKey(cfg, ks, 'worker'), pickKey(cfg, ks, 'orchestrator'), pickKey(cfg, ks, 'judge')];
    const entries = workerKeyEntries(cfg);
    delete process.env.ORCH_PIAUTH_TEST; delete process.env.WORKERS_PIAUTH_TEST;
    return k.every((x) => x && x.value === undefined && x.piAuth === true) && entries.length === 0;
  })());
  eq('pi-auth: buildPiArgs no incluye --api-key aunque le pasen apiKey; pool sí', (() => {
    const base = { provider: 'p', model: 'm', apiKey: 'secreta', prompt: 'x', logFile: path.join('a', 'b', 'x.json'), role: 'x' };
    return !buildPiArgs({ ...base, keysMode: 'pi-auth' }).args.includes('--api-key') && buildPiArgs({ ...base, keysMode: 'pool' }).args.includes('--api-key') && buildPiArgs(base).args.includes('--api-key');
  })());
  eq('isModelEvent: deltas/tool/fin de turno del assistant sí; message_start y keep-alives no', (() => {
    return isModelEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }) && isModelEvent({ type: 'tool_execution_start' })
      && isModelEvent({ type: 'message_end', message: { role: 'assistant' } }) && !isModelEvent({ type: 'message_start', message: { role: 'assistant', stopReason: 'pending' } })
      && !isModelEvent({ type: 'agent_start' }) && !isModelEvent({ type: 'message_end', message: { role: 'system' } }) && !isModelEvent({});
  })());
  // D7: sin request a un provider que no es opencode-go (un fetch que falla si se llama)
  {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('no debería hacer ninguna request'); };
    try {
      const direct = { provider: 'deepseek', keys: { mode: 'pi-auth' } };
      const u = await fetchUsage(direct, 'una-key', { noCache: true });
      const lm = await fetchLiveModels({ baseUrl: 'https://x.invalid/v1', apiKey: 'una-key', config: direct });
      const poolDeepseek = await fetchUsage({ provider: 'deepseek' }, 'otra-key', { noCache: true });   // pool + otro provider: tampoco filtra la key
      eq('D7: pi-auth + provider ≠ opencode-go → fetchUsage/fetchLiveModels no llaman a fetch', calls === 0 && u === null && Array.isArray(lm) && lm.length === 0 && poolDeepseek === null);
      eq('D7: providerQueryAllowed — opencode-go sí; otro provider sólo con providerBaseUrl explícito', providerQueryAllowed({ provider: 'opencode-go' }) && providerQueryAllowed({}) && !providerQueryAllowed({ provider: 'deepseek' }) && providerQueryAllowed({ provider: 'deepseek', providerBaseUrl: 'https://api.deepseek.com' }));
      // opencode-go (default) sigue consultando /usage con su key
      globalThis.fetch = async (url) => { calls++; return { ok: true, json: async () => ({ usage: { rolling: { percent: 5 } } }), url }; };
      const okUsage = await fetchUsage({ provider: 'opencode-go' }, 'key-opencode', { noCache: true });
      eq('D7: con opencode-go el comportamiento de fetchUsage no cambia', calls === 1 && okUsage?.rolling?.percent === 5);
    } finally { globalThis.fetch = realFetch; }
  }
  // runPiResilient (D4/D5) con un `run` inyectado: sin procesos ni esperas reales
  {
    const script = (outs) => { const q = [...outs]; const calls = []; return { calls, run: async () => { calls.push(1); return { ...(q.length > 1 ? q.shift() : q[0]) }; } }; };
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const r429 = { stderr: '429 Too Many Requests', exhausted: true, code: 1, text: '' };
    const okOut = { stderr: '', exhausted: false, code: 0, text: 'hecho' };
    const base = { keysMode: 'pi-auth', retryBackoffMs: [10, 20], provider: 'deepseek', model: 'deepseek-flash', role: 'author' };

    let s = script([r429, okOut]); waits.length = 0;
    let o = await runPiResilient(base, { run: s.run, sleep });
    eq('D4 pi-auth: un 429 reintenta con el primer backoff y pasa', s.calls.length === 2 && waits.join() === '10' && !o.providerUnavailable && o.text === 'hecho' && o.exhausted === false);

    s = script([r429]); waits.length = 0;
    o = await runPiResilient(base, { run: s.run, sleep });
    eq('D4 pi-auth: 429 sostenido → 1 + len(backoff) invocaciones y providerUnavailable (rate-limit, clase quota); no exhausted', s.calls.length === 3 && waits.join() === '10,20' && o.providerUnavailable?.reason === 'rate-limit' && o.providerUnavailable?.class === 'quota' && o.exhausted === false);

    s = script([{ stderr: '402 Payment Required: insufficient balance', exhausted: true, code: 1 }]); waits.length = 0;
    o = await runPiResilient(base, { run: s.run, sleep });
    eq('D4 pi-auth: 402 → providerUnavailable inmediato (funds), sin reintento ni espera', s.calls.length === 1 && waits.length === 0 && o.providerUnavailable?.reason === 'funds' && o.exhausted === false);

    s = script([{ stderr: '401 Unauthorized', exhausted: true, code: 1 }]);
    o = await runPiResilient(base, { run: s.run, sleep });
    eq('D4 pi-auth: 401 → providerUnavailable inmediato (auth)', s.calls.length === 1 && o.providerUnavailable?.reason === 'auth');

    s = script([{ stalled: true, code: 125 }, okOut]);
    o = await runPiResilient(base, { run: s.run, sleep });
    eq('D5: una cola colgada se reintenta una vez y, si responde, sigue', s.calls.length === 2 && !o.providerUnavailable && o.text === 'hecho');

    s = script([{ stalled: true, code: 125 }]);
    o = await runPiResilient({ ...base, keysMode: 'pool' }, { run: s.run, sleep });
    eq('D5 pool: dos colgadas seguidas → providerUnavailable (stalled)', s.calls.length === 2 && o.providerUnavailable?.reason === 'stalled');

    s = script([r429]); waits.length = 0;
    o = await runPiResilient({ ...base, keysMode: 'pool' }, { run: s.run, sleep });
    eq('pool: un 429 NO se reintenta ni cambia (sigue devolviendo exhausted para rotar la key)', s.calls.length === 1 && waits.length === 0 && o.exhausted === true && !o.providerUnavailable);
  }

  const failed = t.filter((x) => !x.ok);
  for (const x of t) console.log(`${x.ok ? '✓' : '✗'} ${x.name}`);
  console.log(`\nself-test: ${t.length - failed.length}/${t.length} OK`);
  process.exit(failed.length ? 1 : 0);
}
