/** Self-test de lógica pura (movido fuera del entrypoint). */
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { RUNS } from "./paths.mjs";
import { slugify, normalizeWorkOrder, validateWorkOrder, compactFindings, extractLastJson, findingsSignature, pathsConflict, isProtected, isProtectedChange, changesScope, gateCommands, workOrderText, pickAuthorVerifier, pickFallbackPair, recordUsage, budgetStatus, shouldMetaReview, detectExhausted, normalizeVerdict, detectUnusableModel, blacklistModel, classifyExhaustion, baselinePolicy, isTransportError, noUsableVerdict } from "./pure.mjs";
import { runProcess, streamPathFor, heartbeatPathFor, buildPiArgs, promptArgFor } from "./runner.mjs";
import { makeKeyState, parseKeyList, workerKeyEntries, pickKey, worstQuotaPct, orderPoolByQuota } from "./keys.mjs";
import { idVariants, modelFamily, bestArenaMatch, rankModels, configPatchFromRanking } from "./rank.mjs";
import { normalize, matchModel } from "./leaderboard.mjs";
import { summarizeLedger } from "./report.mjs";
import { rankingsStale, maxAgeHoursOf } from "./models.mjs";
import { scoutCacheKey, socraticodeOptions, buildScoutPrompt, looksLikeMap } from "./scout.mjs";
import { parseUsage, quotaStatus } from "./usage.mjs";
import { estimateRemaining } from "./cost.mjs";
import { exportGuards, matchGlob, denyReadHit, denyCommandHit, extractPaths, lintAcceptance } from "./guards.mjs";
import { renderDashboardPlain, renderDashboard } from "./dashboard.mjs";
import { resolveLinkTargets } from "./worktrees.mjs";
import { stubModel } from "./stub.mjs";
import { parseArgs } from "./args.mjs";

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
    const f = promptArgFor(['--x'], 'a'.repeat(20000), null, { shell: true });
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
  eq('exportGuards defaults/off', exportGuards({}).denyRead.length > 0 && exportGuards({ guards: { enabled: false } }) === null);
  eq('extractPaths', extractPaths('correr contra lab/proto/proto.db y listo').includes('lab/proto/proto.db'));
  eq('lintAcceptance (T-08)', (() => {
    const r = lintAcceptance({ task: { acceptance: ['correr lab/proto/proto.db'] }, protectedPaths: [], isIgnored: (p) => p.includes('proto.db'), exists: () => true });
    return r.warnings.some((w) => /ignorada/.test(w));
  })());
  eq('classifyExhaustion fondos/cuota/auth (T-06)', classifyExhaustion({ errorMessage: '402 Insufficient account funds' }) === 'funds' && classifyExhaustion({ stderr: '429 Too Many Requests' }) === 'quota' && classifyExhaustion({ stderr: '401 Unauthorized' }) === 'auth' && classifyExhaustion({ stderr: 'ok' }) === null);
  eq('looksLikeMap (T-10)', looksLikeMap('- lib/rank.mjs:12 — arma pools') === true && looksLikeMap('I need to look at the header structure then add a GET endpoint') === false);

  const failed = t.filter((x) => !x.ok);
  for (const x of t) console.log(`${x.ok ? '✓' : '✗'} ${x.name}`);
  console.log(`\nself-test: ${t.length - failed.length}/${t.length} OK`);
  process.exit(failed.length ? 1 : 0);
}
