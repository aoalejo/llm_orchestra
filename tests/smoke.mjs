#!/usr/bin/env node
/**
 * Smoke test de integración del ciclo completo — sin red y sin keys.
 *
 * Crea un repo git temporal, hace `orchestra init` y corre el driver con el
 * runner stub (`--stub`), que además deja un cambio real en el worktree
 * (`ORCHESTRA_STUB_TOUCH=1`) para ejercitar commit + merge de verdad.
 *
 * Cubre las invariantes del ciclo:
 *   1. `init` scaffoldea `.orchestra/`.
 *   2. `--dry-run` NO muta el backlog ni commitea.
 *   3. Ruta protegida sin `--yes` → no integra.
 *   4. Ruta protegida con `--yes` → integra, commitea y limpia worktree/rama.
 *   5. `--all --workers 2` en paralelo → ambas done, commits reales, sin basura.
 *   6. `report --json` agrega el ledger.
 *   7. `--self-test` pasa.
 *
 * Uso:  node tests/smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lsIndexEntries, restoreIndex } from '../lib/verify.mjs';
import { changedFiles, writeDiff } from '../lib/runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, '..', 'orchestra.mjs');

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra: cond ? '' : extra });

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env, shell: false });
  const out = r.stdout ?? '';
  const err = r.stderr ?? '';
  return { code: r.status ?? 1, out, err, all: out + err };
}
const git = (args, cwd) => sh('git', args, cwd);
const orchestra = (args, cwd, env) => sh(process.execPath, [DRIVER, ...args], cwd, env);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const commitCount = (cwd) => Number(git(['rev-list', '--count', 'HEAD'], cwd).out.trim() || '0');
const branches = (cwd) => git(['branch', '--list', 'orchestra/*'], cwd).out.trim();
const hasBranch = (cwd, id) => branches(cwd).includes(`orchestra/${id}`);
const treeFiles = (cwd) => git(['ls-tree', '-r', 'HEAD', '--name-only'], cwd).out;
const worktreesLeft = (cwd) => {
  const d = path.join(cwd, '.orchestra', 'worktrees');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => !x.startsWith('.')).length : 0;
};

/* ── setup ─────────────────────────────────────────────────────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-smoke-'));
let ext = null;   // repo externo (P00096): QA sobre un worktree que NO creó Orchestra
const ENV = { ...process.env, ORCHESTRA_STUB_TOUCH: '1', ORCHESTRA_RUNNER: '', ORCHESTRA_PI_CLI: '', ORCHESTRA_AGENTS_DIR: '', ORCHESTRA_STUB_VERIFIER_ERROR: '' };
delete ENV.OPENCODE_GO_KEY_ORCHESTRATOR;
delete ENV.OPENCODE_GO_KEY_WORKER_1;
delete ENV.OPENCODE_GO_KEY_WORKER_2;

try {
  git(['init', '-q'], tmp);
  git(['config', 'user.email', 'smoke@orchestra.local'], tmp);
  git(['config', 'user.name', 'smoke'], tmp);
  git(['config', 'commit.gpgsign', 'false'], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), '# smoke\n');
  git(['add', '-A'], tmp);
  git(['commit', '-qm', 'init'], tmp);

  // 1. init
  const init = orchestra(['init'], tmp, ENV);
  const O = path.join(tmp, '.orchestra');
  check('init crea .orchestra/', init.code === 0 && fs.existsSync(path.join(O, 'config.json'))
    && fs.existsSync(path.join(O, 'STATE.md')) && fs.existsSync(path.join(O, 'tasks.json'))
    && fs.existsSync(path.join(O, '.gitignore')), init.out);

  // config mínima y determinista para el smoke (sin red, gate trivial)
  const cfg = readJson(path.join(O, 'config.json'));
  cfg.loop = { ...cfg.loop, maxCycles: 2, maxParallelTasks: 2 };
  cfg.gates = { smoke: ['node -e "process.exit(0)"'] };
  cfg.protectedPaths = ['secret/'];
  cfg.models = { ...(cfg.models || {}), rankings: { enabled: false } };
  cfg.scout = { enabled: true, provider: 'llm', cache: { maxAgeMinutes: 0 } };
  fs.writeFileSync(path.join(O, 'config.json'), JSON.stringify(cfg, null, 2));

  const tasks = {
    tasks: [
      { id: 't1', title: 'Uno', status: 'pending', risk: 'medium', targets: ['smoke'], scope: ['src/a.js'], acceptance: ['c1'], attempts: 0 },
      { id: 't2', title: 'Dos', status: 'pending', risk: 'high', targets: ['smoke'], scope: ['src/b.js'], acceptance: ['c2'], attempts: 0 },
      { id: 't3', title: 'Protegida', status: 'pending', risk: 'high', targets: ['smoke'], scope: ['secret/x.js'], acceptance: ['c3'], attempts: 0 },
    ],
  };
  fs.writeFileSync(path.join(O, 'tasks.json'), JSON.stringify(tasks, null, 2));
  const tasksBefore = fs.readFileSync(path.join(O, 'tasks.json'), 'utf8');
  const base = commitCount(tmp);

  // 2. dry-run no muta nada (modo chat: sin --commit queda needs-approval)
  const dry = orchestra(['--task', 't1', '--stub', '--dry-run'], tmp, ENV);
  check('dry-run sale 0', dry.code === 0, dry.out.slice(-400));
  check('dry-run no muta tasks.json', fs.readFileSync(path.join(O, 'tasks.json'), 'utf8') === tasksBefore);
  check('dry-run no commitea', commitCount(tmp) === base, `${commitCount(tmp)} vs ${base}`);
  check('dry-run queda needs-approval', readJson(path.join(O, 'runs', 't1', 'state.json')).status === 'needs-approval');

  // 2b. Corte de transporte del proveedor (400) en un verifier: se reintenta con otro modelo EN EL
  //     MISMO ciclo (no se pierde el diff del autor) en vez de contarlo como veredicto FAIL.
  const retry = orchestra(['--task', 't2', '--stub', '--dry-run'], tmp, {
    ...ENV, ORCHESTRA_STUB_VERIFIER_ERROR: 'deepseek-v4.1-flash',
  });
  check('reintenta la verificación tras un 400 del proveedor', /reintento con qwen3\.8-flash/.test(retry.all), retry.all.slice(-600));
  check('el reintento conserva el ciclo (t2 termina needs-approval)', readJson(path.join(O, 'runs', 't2', 'state.json')).status === 'needs-approval', retry.all.slice(-300));

  // 2c. P00119: con verify.parallel + loop.doubleVerifyAlways, una tarea de riesgo medio pasa por dos
  //     verificadores distintos a la vez (y sin seguridad, que sigue siendo sólo para riesgo alto).
  const cfgPar = readJson(path.join(O, 'config.json'));
  fs.writeFileSync(path.join(O, 'config.json'), JSON.stringify({
    ...cfgPar, verify: { ...(cfgPar.verify || {}), parallel: true }, loop: { ...cfgPar.loop, doubleVerifyAlways: true },
  }, null, 2));
  fs.rmSync(path.join(O, 'runs', 't1'), { recursive: true, force: true });
  const par = orchestra(['--task', 't1', '--stub', '--dry-run'], tmp, ENV);
  const parLine = (par.all.match(/verificando en paralelo: ([^\n]*)/) || [])[1] || '';
  const [pa, pb] = [/a=(\S+)/.exec(parLine)?.[1], /b=(\S+)/.exec(parLine)?.[1]];
  check('verify.parallel: A y B a la vez con modelos distintos', pa && pb && pa !== pb && !/sec=/.test(parLine), par.all.slice(-600));
  check('verify.parallel: dos veredictos y t1 needs-approval', (() => {
    const runDir = path.join(O, 'runs', 't1');
    const st = readJson(path.join(runDir, 'state.json'));
    const vfile = fs.readdirSync(runDir).filter((d) => /^cycle-/.test(d)).map((d) => path.join(runDir, d, 'verdict.json')).find((p) => fs.existsSync(p));
    return st.status === 'needs-approval' && vfile && readJson(vfile).length === 2;
  })(), par.all.slice(-300) + ' runs=' + fs.readdirSync(path.join(O, 'runs', 't1')).join(','));
  fs.writeFileSync(path.join(O, 'config.json'), JSON.stringify(cfgPar, null, 2));

  // 3. protegida sin --yes → no integra
  const prot = orchestra(['--task', 't3', '--stub', '--commit'], tmp, ENV);
  check('protegida sin --yes avisa', /ruta protegida/i.test(prot.all), prot.all.slice(-400));
  check('protegida sin --yes no commitea', commitCount(tmp) === base, `${commitCount(tmp)} vs ${base}`);
  check('protegida sin --yes no marca done', readJson(path.join(O, 'tasks.json')).tasks.find((t) => t.id === 't3').status !== 'done');

  // 4. protegida con --yes → integra de verdad (state fresco para que corra el author)
  fs.rmSync(path.join(O, 'runs', 't3'), { recursive: true, force: true });
  const headBefore = git(['rev-parse', 'HEAD'], tmp).out.trim();
  const protYes = orchestra(['--task', 't3', '--stub', '--commit', '--yes'], tmp, ENV);
  const afterYes = commitCount(tmp);
  // 3 commits, no 2: el de la tarea + el `merge --no-ff` + el del scribe, que ahora corre por su
  // cuenta (si no, el merge pisaba lo que el scribe escribió en ROOT — lib/commands.mjs:81).
  check('protegida con --yes integra (commit + merge + scribe)', (() => {
    const log = git(['log', '--oneline', `${headBefore}..HEAD`], tmp).out;
    return protYes.code === 0 && afterYes - base === 3 && /docs\(scribe\)/.test(log);
  })(), `${afterYes - base} commits (esperados 3)\n${git(['log', '--oneline', '--format=%s', `${headBefore}..HEAD`], tmp).out}${protYes.out.slice(-200)}`);
  check('protegida con --yes marca done', readJson(path.join(O, 'tasks.json')).tasks.find((t) => t.id === 't3').status === 'done');
  // Ojo: t1 conserva su worktree a propósito (venía de un --dry-run); sólo t3 debe limpiarse.
  check('t3: worktree y rama limpios tras integrar',
    !hasBranch(tmp, 't3') && !fs.existsSync(path.join(O, 'worktrees', 't3')),
    `ramas=${branches(tmp).replace(/\n/g, ' ')}`);
  check('el commit incluye el cambio del author', /stub-change-/.test(treeFiles(tmp)), treeFiles(tmp).slice(-300));

  // 5. paralelo: t1 y t2 (t3 ya está done)
  fs.rmSync(path.join(O, 'runs'), { recursive: true, force: true });
  const beforeAll = commitCount(tmp);
  const all = orchestra(['--all', '--workers', '2', '--stub', '--commit'], tmp, ENV);
  const afterAll = commitCount(tmp);
  const doneIds = readJson(path.join(O, 'tasks.json')).tasks.filter((t) => t.status === 'done').map((t) => t.id);
  check('--all sale 0', all.code === 0, all.out.slice(-400));
  check('--all marca t1 y t2 done', doneIds.includes('t1') && doneIds.includes('t2'), doneIds.join(','));
  // 5 ó 6: con 2 workers, los dos markTask pueden caer antes del primer commitScribeDocs (la cola
  // book y la git son distintas) → el segundo commit sale limpio. Lo que no puede pasar: que quede
  // algo sin commitear (la queja del worktree mugriento).
  check('--all commitea por tarea (commit + merge + scribe c/ tasks.json)', afterAll - beforeAll >= 5 && afterAll - beforeAll <= 6, `${afterAll - beforeAll} commits (esperados 5-6)`);
  check('--all deja el worktree limpio', git(['status', '--porcelain'], tmp).out.trim() === '', git(['status', '--porcelain'], tmp).out);
  check('--all no deja worktrees ni ramas', worktreesLeft(tmp) === 0 && branches(tmp) === '', `wt=${worktreesLeft(tmp)} br=${branches(tmp)}`);
  check('ledger registra scout/author/verifier (T-01)', (() => {
    const roles = new Set(fs.readFileSync(path.join(O, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l).role; } catch { return null; } }).filter(Boolean));
    return roles.has('author') && roles.has('verifier') && roles.has('scout');
  })());
  check('last-run.json coherente', (() => {
    const lr = readJson(path.join(O, 'runs', 'last-run.json'));
    return lr.results.length === 2 && lr.results.every((r) => r.approved === true && r.integration === true);
  })());
  check('ledger.jsonl con eventos', fs.readFileSync(path.join(O, 'ledger.jsonl'), 'utf8').trim().split('\n').length >= 2);

  // 6. report
  const rep = orchestra(['report', '--json'], tmp, ENV);
  check('report --json es JSON válido', (() => {
    try { const j = JSON.parse(rep.out); return j.events > 0 && !!j.byRole.author && !!j.byTask.t1; } catch { return false; }
  })(), rep.out.slice(0, 200));

  // 8. modo chat: scout / dispatch / status / approve — ojo: el dispatch sin --commit no commitea,
  // pero approve sí, y ahora el commit del scribe se lleva también .orchestra/tasks.json (la marca
  // done), así que cada integración son 3 commits, no 2.
  const scout = orchestra(['scout', '--query', 'recon de smoke', '--stub', '--json'], tmp, ENV);
  check('scout --json responde ok', (() => {
    try { const j = JSON.parse(scout.out); return j.status === 'ok' && typeof j.map === 'string'; } catch { return false; }
  })(), scout.out.slice(0, 200));

  const beforeChat = commitCount(tmp);
  const order = JSON.stringify({ id: 'chat1', goal: 'crear archivo', acceptance: ['existe el cambio'], scope: ['stub-change-*'] });
  const disp = orchestra(['dispatch', '--order', order, '--stub', '--json'], tmp, ENV);
  check('dispatch corre y queda needs-approval', (() => {
    try { const j = JSON.parse(disp.out); return j.results?.length === 1 && j.results[0].status === 'needs-approval' && j.results[0].approved === false; } catch { return false; }
  })(), disp.out.slice(0, 400));
  check('dispatch no commitea sin --commit', commitCount(tmp) === beforeChat);

  const status = orchestra(['status', '--json'], tmp, ENV);
  check('status muestra chat1 en needs-approval', (() => {
    try { const j = JSON.parse(status.out); const t = (j.tasks || []).find((x) => x.id === 'chat1'); return !!t && t.state === 'needs-approval'; } catch { return false; }
  })(), status.out.slice(0, 400));

  // `status --runs` marca `dead` un batch cuyo proceso ya murió (antes quedaba en `running` para
  // siempre: el path de un run puntual chequeaba el pid, el listado no — medido 2026-09-27).
  {
    const runs = path.join(O, 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const marker = (runId, pid) => fs.writeFileSync(path.join(runs, runId + '.json'),
      JSON.stringify({ runId, pid, startedAt: new Date().toISOString(), status: 'running', orders: [runId] }));
    marker('batch-vivo', process.pid);
    marker('batch-muerto', 999999);
    const st = orchestra(['status', '--runs', '--json'], tmp, ENV);
    check('status --runs: el batch con pid vivo sigue running y el muerto pasa a dead', (() => {
      try {
        const by = Object.fromEntries(JSON.parse(st.out).runs.map((r) => [r.runId, r.status]));
        return by['batch-vivo'] === 'running' && by['batch-muerto'] === 'dead';
      } catch { return false; }
    })(), st.out.slice(0, 300));
    fs.rmSync(path.join(runs, 'batch-vivo.json'), { force: true });
    fs.rmSync(path.join(runs, 'batch-muerto.json'), { force: true });
  }

  const appr = orchestra(['approve', '--task', 'chat1', '--commit', '--stub', '--json'], tmp, ENV);
  check('approve integra (commit + merge + scribe)', (() => {
    try { const j = JSON.parse(appr.out); return j.approved === true && j.integration?.ok === true && commitCount(tmp) - beforeChat === 3; } catch { return false; }
  })(), appr.out.slice(0, 400));
  check('approve marca chat1 done', readJson(path.join(O, 'tasks.json')).tasks.find((t) => t.id === 'chat1')?.status === 'done');
  check('el commit de approve incluye el cambio', /stub-change-/.test(treeFiles(tmp)));
  check('approve limpia worktree/rama', worktreesLeft(tmp) === 0 && branches(tmp) === '', `wt=${worktreesLeft(tmp)} br=${branches(tmp)}`);

  // 8b. dispatch multi-orden (disjuntas) en paralelo, con --commit
  const beforeBatch = commitCount(tmp);
  const o1 = JSON.stringify({ id: 'b1', goal: 'backend', acceptance: ['a'], scope: ['stub-b1-*'] });
  const o2 = JSON.stringify({ id: 'b2', goal: 'frontend', acceptance: ['b'], scope: ['stub-b2-*'] });
  const batch = orchestra(['dispatch', '--order', o1, '--order', o2, '--workers', '2', '--stub', '--commit', '--json'], tmp, ENV);
  check('dispatch multi-orden integra ambas', (() => {
    try { const j = JSON.parse(batch.out); return j.results.length === 2 && j.results.every((r) => r.approved) && commitCount(tmp) - beforeBatch >= 5 && commitCount(tmp) - beforeBatch <= 6 && git(['status', '--porcelain'], tmp).out.trim() === ''; } catch { return false; }
  })(), batch.out.slice(0, 500));
  const doneAfterBatch = readJson(path.join(O, 'tasks.json')).tasks.filter((t) => t.status === 'done').map((t) => t.id);
  check('dispatch multi-orden marca done', doneAfterBatch.includes('b1') && doneAfterBatch.includes('b2'), doneAfterBatch.join(','));
  check('dispatch multi-orden limpia worktrees', worktreesLeft(tmp) === 0 && branches(tmp) === '', `wt=${worktreesLeft(tmp)} br=${branches(tmp)}`);

  // 8c. T-04: dispatch --detach devuelve runId y status --run refleja el avance
  const det = orchestra(['dispatch', '--order', JSON.stringify({ id: 'd1', goal: 'detach', acceptance: ['x'], scope: ['stub-*'] }), '--stub', '--detach', '--json'], tmp, ENV);
  let detRunId = null;
  try { detRunId = JSON.parse(det.out).runId; } catch { /* noop */ }
  check('dispatch --detach devuelve runId', !!detRunId && /^batch-/.test(detRunId), det.out.slice(0, 200));
  let runSt = null;
  for (let i = 0; i < 15 && detRunId; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { runSt = JSON.parse(orchestra(['status', '--run', detRunId, '--json'], tmp, ENV).out); } catch { /* noop */ }
    if (runSt && runSt.status === 'done') break;
  }
  check('status --run refleja el avance', !!runSt && runSt.status === 'done' && (runSt.tasks || []).length === 1, JSON.stringify(runSt).slice(0, 250));

  // 9. scout con SocratiCode (fake MCP server) + cache + fallback
  const fakeMcp = path.join(HERE, 'helpers', 'fake-mcp.mjs');
  const cfgPath = path.join(O, 'config.json');
  const c9 = readJson(cfgPath);
  c9.scout = { enabled: true, provider: 'socraticode', cache: { maxAgeMinutes: 720 }, socraticode: { command: process.execPath, args: [fakeMcp], timeoutMs: 20000 } };
  fs.writeFileSync(cfgPath, JSON.stringify(c9, null, 2));
  const sc1 = orchestra(['scout', '--query', 'foo', '--stub', '--json'], tmp, ENV);
  check('scout socraticode usa el MCP', (() => { try { const j = JSON.parse(sc1.out); return j.source === 'socraticode+llm' && /export const foo/.test(j.chunks || ''); } catch { return false; } })(), sc1.out.slice(0, 500));
  const sc2 = orchestra(['scout', '--query', 'foo', '--stub', '--json'], tmp, ENV);
  check('scout usa cache (segunda vez)', (() => { try { return JSON.parse(sc2.out).cached === true; } catch { return false; } })(), sc2.out.slice(0, 300));
  c9.scout.socraticode = { command: 'definitely-not-a-real-cmd-xyz', args: [], timeoutMs: 5000 };
  c9.scout.cache = { maxAgeMinutes: 0 };
  fs.writeFileSync(cfgPath, JSON.stringify(c9, null, 2));
  const sc3 = orchestra(['scout', '--query', 'foo', '--stub', '--json'], tmp, ENV);
  check('scout cae a LLM si socraticode falla', (() => { try { const j = JSON.parse(sc3.out); return j.status === 'ok' && j.source === 'llm'; } catch { return false; } })(), sc3.out.slice(0, 400));

  // 9b. usage (sin keys configuradas → accounts vacío)
  const usg = orchestra(['usage', '--json'], tmp, ENV);
  check('usage --json responde', (() => { try { return Array.isArray(JSON.parse(usg.out).accounts); } catch { return false; } })(), usg.out.slice(0, 300));

  // 9c. dashboard
  const dash = orchestra(['dashboard', '--once', '--json'], tmp, ENV);
  check('dashboard --once --json responde', (() => { try { const j = JSON.parse(dash.out); return Array.isArray(j.tasks) && typeof j.summary === 'object'; } catch { return false; } })(), dash.out.slice(0, 300));

  // 10. Proveedores directos (P00095): keys.mode "pi-auth", modelo "<provider>/<modelo>" por rol, 429 con
  //     backoff, 402 inmediato y cola colgada. Corre el runner REAL contra un pi falso (tests/helpers/fake-pi.mjs).
  {
    const fakePi = path.join(HERE, 'helpers', 'fake-pi.mjs');
    const c10 = readJson(cfgPath);
    c10.provider = 'deepseek';
    c10.keys = { mode: 'pi-auth', retryBackoffMs: [50, 50] };
    c10.roles = { ...c10.roles, author: ['deepseek/deepseek-flash'], verifier: ['xiaomi-token-plan-sgp/mimo-v2.6-flash'], security: 'deepseek/deepseek-flash', scout: 'deepseek/deepseek-flash', scribe: 'deepseek/deepseek-flash', merge: 'deepseek/deepseek-flash' };
    c10.loop = { ...c10.loop, maxCycles: 1, maxParallelTasks: 1, firstTokenTimeoutMs: 1500 };
    c10.scout = { enabled: true, provider: 'llm', cache: { maxAgeMinutes: 0 } };
    c10.gates = { smoke: ['node -e "process.exit(0)"'] };
    c10.models = { ...(c10.models || {}), rankings: { enabled: false } };
    fs.writeFileSync(cfgPath, JSON.stringify(c10, null, 2));
    fs.writeFileSync(path.join(O, 'ledger.jsonl'), '');
    const counter = path.join(tmp, 'fakepi-count');
    const count = (id, role) => { try { return Number(fs.readFileSync(`${counter}-${id}.${role}`, 'utf8')); } catch { return 0; } };
    const run10 = (id, fake) => {
      const o = JSON.stringify({ id, goal: 'proveedor directo', acceptance: ['existe el cambio'], scope: ['fake-change-*'] });
      const env = { ...ENV, ORCHESTRA_PI_CLI: fakePi, FAKE_PI_COUNTER: `${counter}-${id}`, ...fake };
      const r = orchestra(['dispatch', '--order', o, '--json'], tmp, env);
      let j = null;
      try { j = JSON.parse(r.out).results[0]; } catch { /* noop */ }
      return { r, j };
    };
    const ledger10 = () => fs.readFileSync(path.join(O, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const piArg = (args, flag) => args[args.indexOf(flag) + 1];
    const cycleLog = (id, file) => readJson(path.join(O, 'runs', id, 'cycle-1', file));

    // un 429 (sólo la primera vez) → reintenta la misma invocación y el run termina bien
    const a = run10('pa-429-una', { FAKE_PI_ERROR: '429', FAKE_PI_FAIL_FIRST: '1' });
    check('pi-auth: un 429 reintenta y el run pasa (needs-approval)', a.j?.status === 'needs-approval' && count('pa-429-una', 'author') === 2, a.r.all.slice(-500));
    check('provider por rol: author con deepseek, verifier con xiaomi; sin --api-key', (() => {
      const au = cycleLog('pa-429-una', 'author.json').args;
      const ve = cycleLog('pa-429-una', 'verdict-a.json').args;
      return piArg(au, '--provider') === 'deepseek' && piArg(au, '--model') === 'deepseek-flash'
        && piArg(ve, '--provider') === 'xiaomi-token-plan-sgp' && piArg(ve, '--model') === 'mimo-v2.6-flash'
        && !au.includes('--api-key') && !ve.includes('--api-key');
    })());

    // 429 siempre → 1 + 2 reintentos = 3 invocaciones y provider-unavailable
    const b = run10('pa-429-siempre', { FAKE_PI_ERROR: '429' });
    check('pi-auth: 429 repetido → provider-unavailable tras agotar los reintentos',
      b.j?.status === 'provider-unavailable' && b.j?.decision?.reason === 'provider-unavailable' && b.j?.decision?.role === 'author'
      && b.j?.decision?.cause === 'rate-limit' && count('pa-429-siempre', 'author') === 3, JSON.stringify(b.j?.decision) + b.r.all.slice(-300));

    // 402 → inmediato, sin reintento
    const c = run10('pa-402', { FAKE_PI_ERROR: '402' });
    check('pi-auth: 402 → provider-unavailable sin reintento (clase funds)',
      c.j?.status === 'provider-unavailable' && c.j?.decision?.cause === 'funds' && c.j?.decision?.class === 'funds' && count('pa-402', 'author') === 1,
      JSON.stringify(c.j?.decision) + c.r.all.slice(-300));

    // cola colgada: 0 eventos del modelo → se mata a los firstTokenTimeoutMs (1,5 s), 1 reintento, provider-unavailable
    const t0 = Date.now();
    const d = run10('pa-stall', { FAKE_PI_ERROR: 'stall' });
    check('cola colgada: se mata, se reintenta una vez y termina provider-unavailable',
      d.j?.status === 'provider-unavailable' && d.j?.decision?.cause === 'stalled' && count('pa-stall', 'author') === 2 && Date.now() - t0 < 60000,
      JSON.stringify(d.j?.decision) + d.r.all.slice(-300));
    check('cola colgada: el log del rol deja stalled:true (código 125) y el proceso se cortó antes del tope del fake', (() => {
      const l = cycleLog('pa-stall', 'author.json');
      return l.stalled === true && l.code === 125 && l.durationMs < 20000;
    })());

    // status: el estado final se ve como needs-decision (state + decision con el rol que falló)
    const st10 = orchestra(['status', '--json'], tmp, ENV);
    check('status muestra provider-unavailable con su decision', (() => {
      try { const t = JSON.parse(st10.out).tasks.find((x) => x.id === 'pa-402'); return t.state === 'provider-unavailable' && t.decision?.role === 'author'; } catch { return false; }
    })(), st10.out.slice(0, 300));

    // ninguna llamada marcó una key agotada: el ledger no tiene exhausted:true y las fallas quedan como providerUnavailable
    const led = ledger10();
    check('pi-auth: ninguna llamada marca key agotada (ledger)',
      led.length > 0 && led.every((e) => !e.exhausted) && led.some((e) => e.providerUnavailable === 'rate-limit') && led.some((e) => e.providerUnavailable === 'funds'),
      JSON.stringify(led.slice(-3)));
  }

  const fakePi = path.join(HERE, 'helpers', 'fake-pi.mjs');

  // 11. verify (P00096): QA independiente sobre un worktree EXTERNO, con gates + verifier simulado
  //     y la guarda de permisos D2 (sólo `zz-qa-*` puede tocar el worktree).
  {
    // Repo externo "escrito por otro autor": rama main con la base, rama `autor` con un commit
    // (base...HEAD) y un cambio sin commitear (README.md) que la guarda NO debe tocar.
    ext = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-verify-'));
    git(['init', '-q'], ext);
    git(['config', 'user.email', 'verify@smoke.local'], ext);
    git(['config', 'user.name', 'verify-smoke'], ext);
    git(['config', 'commit.gpgsign', 'false'], ext);
    fs.writeFileSync(path.join(ext, 'product.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(ext, 'clean.js'), 'module.exports = "clean";\n');
    fs.writeFileSync(path.join(ext, 'README.md'), '# externo\n');
    fs.mkdirSync(path.join(ext, 'sub'));
    fs.writeFileSync(path.join(ext, 'sub', 'lib.js'), 'module.exports = "sub";\n');
    git(['add', '-A'], ext); git(['commit', '-qm', 'base'], ext);
    git(['branch', '-M', 'main'], ext);
    git(['checkout', '-qb', 'autor'], ext);
    fs.writeFileSync(path.join(ext, 'product.js'), 'module.exports = 2;\n');
    git(['add', '-A'], ext); git(['commit', '-qm', 'feat del autor'], ext);
    fs.writeFileSync(path.join(ext, 'README.md'), '# externo (editado por el autor)\n');

    const order = JSON.stringify({ id: 'qa', goal: 'QA del worktree externo', targets: ['smoke'], scope: ['product.js'], acceptance: ['product.js exporta 2'] });
    const lastRun = (id) => {
      const dirs = fs.readdirSync(path.join(O, 'runs')).filter((x) => x.startsWith(`verify-${id}-`)).sort();
      return path.join(O, 'runs', dirs[dirs.length - 1]);
    };
    const runVerify = (env) => orchestra(['verify', '--worktree', ext, '--order', order, '--json'], tmp,
      { ...ENV, ORCHESTRA_PI_CLI: fakePi, ...env });

    // a) veredicto PASS → exit 0 + report.md/report.json
    const v1 = runVerify({});
    const rd1 = lastRun('qa');
    const rep1 = readJson(path.join(rd1, 'report.json'));
    check('verify: verificador PASS → exit 0', v1.code === 0, v1.all.slice(-400));
    check('verify: report.md + report.json con verdict PASS y gates', (() => {
      const md = fs.readFileSync(path.join(rd1, 'report.md'), 'utf8');
      return rep1.verdict === 'PASS' && rep1.exitCode === 0 && rep1.gates.ok
        && rep1.gates.results.every((g) => g.passed) && /veredicto/.test(md);
    })(), v1.all.slice(-300));
    check('verify: el diff cubre base...HEAD + cambios sin commitear', (() => {
      const d = fs.readFileSync(path.join(rd1, 'diff.patch'), 'utf8');
      return d.includes('module.exports = 2') && d.includes('editado por el autor');
    })());

    // b) veredicto FAIL → exit 1 + findings
    const v2 = runVerify({ FAKE_PI_VERDICT: 'FAIL' });
    const rep2 = readJson(path.join(lastRun('qa'), 'report.json'));
    check('verify: verificador FAIL → exit 1 con findings',
      v2.code === 1 && rep2.verdict === 'FAIL' && rep2.exitCode === 1 && rep2.findings.length >= 1,
      v2.all.slice(-400));

    // c) violación D2: modifica producto + crea foo.ts (se revierten), conserva zz-qa-* , el
    //    trabajo previo del autor NO se toca → exit 2
    const v3 = runVerify({ FAKE_PI_MUTATE: 'clean.js,foo.ts,zz-qa-bar.test.ts' });
    const rep3 = readJson(path.join(lastRun('qa'), 'report.json'));
    const st3 = git(['status', '--porcelain'], ext).out;
    check('verify: violación de permisos → exit 2', v3.code === 2 && rep3.exitCode === 2, v3.all.slice(-500));
    check('D2: el archivo del producto queda revertido y foo.ts borrado',
      fs.readFileSync(path.join(ext, 'clean.js'), 'utf8').replace(/\r\n/g, '\n') === 'module.exports = "clean";\n'
      && !fs.existsSync(path.join(ext, 'foo.ts'))
      && !st3.includes('clean.js') && !st3.includes('foo.ts'), st3);
    check('D2: zz-qa-bar.test.ts se conserva', fs.existsSync(path.join(ext, 'zz-qa-bar.test.ts'))
      && rep3.kept.join(',').includes('zz-qa-bar.test.ts'), JSON.stringify(rep3.kept));
    check('D2: lo que el autor ya había modificado antes no se toca',
      fs.readFileSync(path.join(ext, 'README.md'), 'utf8') === '# externo (editado por el autor)\n'
      && git(['diff', '--name-only'], ext).out.includes('README.md'), st3);
    check('D2: el reporte lista las violaciones',
      rep3.violations.some((v) => v.path === 'clean.js') && rep3.violations.some((v) => v.path === 'foo.ts'),
      JSON.stringify(rep3.violations));

    // c2) violación D2: verifier hace `git add` a un archivo nuevo → se revierte correctamente
    const v3b = runVerify({ FAKE_PI_MUTATE: 'new-added.ts' });
    const rep3b = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: verifier git add foo.ts → unstage + delete, exit 2',
      v3b.code === 2 && rep3b.exitCode === 2 && !fs.existsSync(path.join(ext, 'new-added.ts'))
      && rep3b.violations.some((v) => v.path === 'new-added.ts'),
      v3b.all.slice(-500));

    // c3) violación D2: verifier crea archivo con nombre no-ASCII → se revierte
    const v3c = runVerify({ FAKE_PI_MUTATE: 'café.ts' });
    const rep3c = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: verifier crea café.ts → se borra, exit 2',
      v3c.code === 2 && rep3c.exitCode === 2 && !fs.existsSync(path.join(ext, 'café.ts'))
      && rep3c.violations.some((v) => v.path === 'café.ts'),
      v3c.all.slice(-500));

    // c4) violación D2: verifier modifica archivo limpio + crea archivo nuevo, después commitea
    //     → HEAD se resetea, los cambios quedan modificados, se restauran como violaciones
    const v3d = runVerify({ FAKE_PI_MUTATE: 'clean.js,verifier-new.ts', FAKE_PI_COMMIT: '1' });
    const rep3d = readJson(path.join(lastRun('qa'), 'report.json'));
    const cleanAfter = fs.readFileSync(path.join(ext, 'clean.js'), 'utf8').replace(/\r\n/g, '\n');
    const hasCommitViolation = rep3d.violations.some((v) => v.action === 'reset-soft-por-commit-del-verificador');
    const hasCleanViolation = rep3d.violations.some((v) => v.path === 'clean.js');  // git-checkout
    const hasNewViolation = rep3d.violations.some((v) => v.path === 'verifier-new.ts' && v.action === 'borrado');
    check('D2: verifier commit (modifica limpio + crea nuevo) → HEAD reset, cambios restaurados, exit 2',
      v3d.code === 2 && rep3d.exitCode === 2 && cleanAfter === 'module.exports = "clean";\n'
      && !fs.existsSync(path.join(ext, 'verifier-new.ts'))
      && hasCommitViolation && hasCleanViolation && hasNewViolation,
      v3d.all.slice(-500));

    // c5) violación D2: verifier modifica archivo que el autor ya había modificado → se restaura al estado del autor
    const v3e = runVerify({ FAKE_PI_MUTATE: 'README.md' });
    const rep3e = readJson(path.join(lastRun('qa'), 'report.json'));
    const readmeAfter = fs.readFileSync(path.join(ext, 'README.md'), 'utf8');
    check('D2: verifier modifica README.md (modificado por autor) → restaurado al estado del autor, exit 2',
      v3e.code === 2 && rep3e.exitCode === 2
      && readmeAfter === '# externo (editado por el autor)\n'
      && rep3e.violations.some((v) => v.path === 'README.md' && v.action === 'restaurado-al-estado-del-autor'),
      v3e.all.slice(-500));

    // c6) violación D2: verifier hace `git mv` de un archivo limpio → original restaurado con su contenido,
    //     el nombre nuevo borrado, índice limpio para ambos, violación reportada, exit 2.
    const v3g = runVerify({ FAKE_PI_GITMV: 'clean.js:renamed.js' });
    const rep3g = readJson(path.join(lastRun('qa'), 'report.json'));
    const mvStatus = git(['status', '--porcelain', '--', 'clean.js', 'renamed.js'], ext).out.trim();
    check('D2: verifier git mv de archivo limpio → original restaurado, nuevo borrado, índice limpio, exit 2',
      v3g.code === 2 && rep3g.exitCode === 2
      && fs.existsSync(path.join(ext, 'clean.js'))
      && fs.readFileSync(path.join(ext, 'clean.js'), 'utf8').replace(/\r\n/g, '\n') === 'module.exports = "clean";\n'
      && !fs.existsSync(path.join(ext, 'renamed.js'))
      && !mvStatus
      && rep3g.violations.some((v) => v.path === 'clean.js'),
      `${JSON.stringify(rep3g.violations)} status=${JSON.stringify(mvStatus)} ${v3g.all.slice(-300)}`);

    // c6a) `git mv` de un archivo LIMPIO cuyo nombre empieza con dos mayúsculas (NOTES.md): en -z el token de
    //      la ruta original no lleva estado, así que no se puede adivinar por la forma del nombre.
    fs.writeFileSync(path.join(ext, 'NOTES.md'), 'notas\n');
    git(['add', 'NOTES.md'], ext); git(['commit', '-qm', 'notas'], ext);
    const v3n = runVerify({ FAKE_PI_GITMV: 'NOTES.md:notes2.md' });
    const rep3n = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: verifier git mv de NOTES.md (limpio, nombre en mayúsculas) → restaurado, exit 2',
      v3n.code === 2 && fs.existsSync(path.join(ext, 'NOTES.md')) && !fs.existsSync(path.join(ext, 'notes2.md'))
      && !git(['status', '--porcelain', '--', 'NOTES.md', 'notes2.md'], ext).out.trim()
      && rep3n.violations.some((v) => v.path === 'NOTES.md'),
      `${JSON.stringify(rep3n.violations)} ${v3n.all.slice(-300)}`);

    // c6c) índice envenenado: el verifier escribe basura, `git add`, y restaura los bytes del autor en README.md.
    //      El contenido del worktree no cambia, pero el índice sí → violación '<index>', índice como antes, exit 2.
    const cachedBefore = git(['diff', '--cached', '--name-only'], ext).out.trim();
    const v3i = runVerify({ FAKE_PI_INDEXPOISON: 'README.md' });
    const rep3i = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: índice envenenado (git add + restaurar bytes) → índice restaurado, violación <index>, exit 2',
      v3i.code === 2 && rep3i.violations.some((v) => v.path === '<index>')
      && git(['diff', '--cached', '--name-only'], ext).out.trim() === cachedBefore
      && !git(['show', ':README.md'], ext).out.includes('malicioso')
      && fs.readFileSync(path.join(ext, 'README.md'), 'utf8').replace(/\r\n/g, '\n') === '# externo (editado por el autor)\n',
      `${JSON.stringify(rep3i.violations)} cached=${git(['diff', '--cached', '--name-only'], ext).out} ${v3i.all.slice(-300)}`);

    // c6d) `git add -A` sin tocar bytes: el trabajo del autor no queda staged al terminar.
    const v3j = runVerify({ FAKE_PI_ADDALL: '1' });
    const rep3j = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: git add -A del verifier → índice restaurado (nada del autor queda staged), exit 2',
      v3j.code === 2 && rep3j.violations.some((v) => v.path === '<index>')
      && git(['diff', '--cached', '--name-only'], ext).out.trim() === cachedBefore,
      `${JSON.stringify(rep3j.violations)} ${v3j.all.slice(-300)}`);

    // c6e) el verifier cambia de rama (`git checkout main`) y commitea ahí: la rama vuelve a ser la del autor,
    //      `main` no se mueve, el worktree queda con el contenido del autor; violación <HEAD>, exit 2.
    const mainBefore = git(['rev-parse', 'main'], ext).out.trim();
    const autorBefore = git(['rev-parse', 'autor'], ext).out.trim();
    const v3k = runVerify({ FAKE_PI_CHECKOUT: 'main', FAKE_PI_MUTATE: 'clean.js', FAKE_PI_COMMIT: '1' });
    const rep3k = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: verifier hace checkout de otra rama y commitea → rama del autor, main intacta, contenido del autor, exit 2',
      v3k.code === 2
      && git(['symbolic-ref', 'HEAD'], ext).out.trim() === 'refs/heads/autor'
      && git(['rev-parse', 'main'], ext).out.trim() === mainBefore
      && git(['rev-parse', 'autor'], ext).out.trim() === autorBefore
      && fs.readFileSync(path.join(ext, 'product.js'), 'utf8').replace(/\r\n/g, '\n') === 'module.exports = 2;\n'
      && fs.readFileSync(path.join(ext, 'clean.js'), 'utf8').replace(/\r\n/g, '\n') === 'module.exports = "clean";\n'
      && fs.readFileSync(path.join(ext, 'README.md'), 'utf8').replace(/\r\n/g, '\n') === '# externo (editado por el autor)\n'
      && rep3k.violations.some((v) => v.path === '<HEAD>'),
      `${JSON.stringify(rep3k.violations)} head=${git(['symbolic-ref', 'HEAD'], ext).out} ${v3k.all.slice(-300)}`);

    // c6f) un archivo de scratch que ya existía (no lo creó este verifier) no se puede modificar.
    fs.mkdirSync(path.join(ext, '.orchestra', 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(ext, '.orchestra', 'scratch', 'previo.txt'), 'de antes\n');
    const v3l = runVerify({ FAKE_PI_MUTATE: '.orchestra/scratch/previo.txt' });
    const rep3l = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: scratch pre-existente modificado por el verifier → violación, restaurado, exit 2',
      v3l.code === 2 && rep3l.violations.some((v) => v.path === '.orchestra/scratch/previo.txt')
      && fs.readFileSync(path.join(ext, '.orchestra', 'scratch', 'previo.txt'), 'utf8').replace(/\r\n/g, '\n') === 'de antes\n',
      `${JSON.stringify(rep3l.violations)} ${v3l.all.slice(-300)}`);
    fs.rmSync(path.join(ext, '.orchestra'), { recursive: true, force: true });

    // c6b) `git mv` de un archivo con cambios del autor sin commitear → vuelve al contenido del AUTOR.
    const v3h = runVerify({ FAKE_PI_GITMV: 'README.md:README2.md' });
    const rep3h = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: verifier git mv de archivo del autor → restaurado al contenido del autor, exit 2',
      v3h.code === 2 && rep3h.exitCode === 2
      && fs.existsSync(path.join(ext, 'README.md'))
      && fs.readFileSync(path.join(ext, 'README.md'), 'utf8').replace(/\r\n/g, '\n') === '# externo (editado por el autor)\n'
      && !fs.existsSync(path.join(ext, 'README2.md'))
      && rep3h.violations.some((v) => v.path === 'README.md'),
      `${JSON.stringify(rep3h.violations)} ${v3h.all.slice(-300)}`);

    // c7) violación D2: verifier modifica zz-qa-*.test que YA EXISTÍA antes → violation (no permitido)
    fs.writeFileSync(path.join(ext, 'zz-qa-pre-existing.test'), 'original qa file\n');
    git(['add', '.'], ext); git(['commit', '-qm', 'pre-existing zz-qa'], ext);
    const v3f = runVerify({ FAKE_PI_MUTATE: 'zz-qa-pre-existing.test' });
    const rep3f = readJson(path.join(lastRun('qa'), 'report.json'));
    const zqaAfter = fs.readFileSync(path.join(ext, 'zz-qa-pre-existing.test'), 'utf8').replace(/\r\n/g, '\n');
    check('D2: verifier modifica zz-qa-*.test pre-existente → violation, restaurado, exit 2',
      v3f.code === 2 && rep3f.exitCode === 2
      && zqaAfter === 'original qa file\n'
      && rep3f.violations.some((v) => v.path === 'zz-qa-pre-existing.test'),
      v3f.all.slice(-500));

    // c8) chmod del verifier sin tocar bytes: el MODO entra en el snapshot → violación y restauración
    //     (sin esto el chmod quedaba invisible en hosts con core.filemode=false, p. ej. Windows).
    fs.writeFileSync(path.join(ext, 'README.md'), '# externo (editado por el autor 2)\n');
    const v3m = runVerify({ FAKE_PI_CHMOD: 'README.md' });
    const rep3m = readJson(path.join(lastRun('qa'), 'report.json'));
    const readmeM = fs.readFileSync(path.join(ext, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    check('D2: chmod del verifier sobre archivo del autor → violación, restaurado (contenido y modo), exit 2',
      v3m.code === 2 && rep3m.exitCode === 2
      && rep3m.violations.some((v) => v.path === 'README.md')
      && readmeM === '# externo (editado por el autor 2)\n'
      && (fs.statSync(path.join(ext, 'README.md')).mode & 0o200) !== 0,
      `${JSON.stringify(rep3m.violations)} mode=${(fs.statSync(path.join(ext, 'README.md')).mode & 0o777).toString(8)} ${v3m.all.slice(-300)}`);

    // c9) symlink/hardlink del verifier sobre un archivo del autor: la restauración NO debe escribir
    //     a través del link (el fichero externo queda intacto) y repone el archivo del autor.
    const victima = path.join(tmp, 'victima-externa.txt');
    fs.writeFileSync(victima, 'archivo externo intacto\n');
    const v3s = runVerify({ FAKE_PI_LINK: 'README.md', FAKE_PI_LINK_TARGET: victima });
    const rep3s = readJson(path.join(lastRun('qa'), 'report.json'));
    const readmeS = fs.readFileSync(path.join(ext, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    check('D2: verifier convierte archivo del autor en symlink/hardlink → violación, restaurado, víctima intacta, exit 2',
      v3s.code === 2 && rep3s.exitCode === 2
      && rep3s.violations.some((v) => v.path === 'README.md')
      && readmeS === '# externo (editado por el autor 2)\n'
      && !fs.lstatSync(path.join(ext, 'README.md')).isSymbolicLink()
      && fs.readFileSync(victima, 'utf8') === 'archivo externo intacto\n',
      `${JSON.stringify(rep3s.violations)} victima=${JSON.stringify(fs.readFileSync(victima, 'utf8'))} ${v3s.all.slice(-300)}`);

    // c9b) mismo ataque sobre un archivo LIMPIO (trackeado): la rama `git checkout` también debe
    //      sacar el link antes de reponer, sin escribir a través de él.
    const victima2 = path.join(tmp, 'victima-externa-2.txt');
    fs.writeFileSync(victima2, 'otro externo intacto\n');
    const v3s2 = runVerify({ FAKE_PI_LINK: 'clean.js', FAKE_PI_LINK_TARGET: victima2 });
    const rep3s2 = readJson(path.join(lastRun('qa'), 'report.json'));
    const cleanS = fs.readFileSync(path.join(ext, 'clean.js'), 'utf8').replace(/\r\n/g, '\n');
    check('D2: symlink/hardlink sobre archivo LIMPIO → checkout lo repone sin escribir a través, víctima intacta, exit 2',
      v3s2.code === 2 && rep3s2.exitCode === 2
      && rep3s2.violations.some((v) => v.path === 'clean.js')
      && cleanS === 'module.exports = "clean";\n'
      && !fs.lstatSync(path.join(ext, 'clean.js')).isSymbolicLink()
      && fs.readFileSync(victima2, 'utf8') === 'otro externo intacto\n',
      `${JSON.stringify(rep3s2.violations)} victima=${JSON.stringify(fs.readFileSync(victima2, 'utf8'))} ${v3s2.all.slice(-300)}`);

    // c10) parent-dir link: el verifier reemplaza un DIRECTORIO del autor por un enlace a un
    //      directorio externo. La restauración no debe escribir a través del enlace (ni borrar el
    //      fichero externo): tiene que sacar el enlace y reponer el archivo del autor.
    fs.writeFileSync(path.join(ext, 'sub', 'lib.js'), 'module.exports = "sub-autor";\n');  // sucio del autor
    const victimaDir = path.join(tmp, 'victima-dir');
    fs.mkdirSync(victimaDir, { recursive: true });
    fs.writeFileSync(path.join(victimaDir, 'lib.js'), 'externo irremplazable\n');
    const v9dir = runVerify({ FAKE_PI_LINKDIR: 'sub', FAKE_PI_LINKDIR_TARGET: victimaDir });
    const rep9dir = readJson(path.join(lastRun('qa'), 'report.json'));
    check('D2: verifier convierte un directorio PADRE en enlace → violación, repuesto, víctima intacta, exit 2',
      v9dir.code === 2 && rep9dir.exitCode === 2
      && rep9dir.violations.some((v) => v.path === 'sub/lib.js')
      && fs.readFileSync(path.join(ext, 'sub', 'lib.js'), 'utf8').replace(/\r\n/g, '\n') === 'module.exports = "sub-autor";\n'
      && !fs.lstatSync(path.join(ext, 'sub')).isSymbolicLink()
      && fs.readFileSync(path.join(victimaDir, 'lib.js'), 'utf8') === 'externo irremplazable\n',
      `${JSON.stringify(rep9dir.violations)} ext=${JSON.stringify(fs.readFileSync(path.join(victimaDir, 'lib.js'), 'utf8'))} ${v9dir.all.slice(-300)}`);

    // c11) `verify --order @archivo` con un ARRAY de una orden (formato de dispatch --orders):
    //      antes llegaba el array crudo a normalizeWorkOrder y moría con id/goal vacíos.
    //      OJO: id 'qaarr' (sin guión) para que `lastRun('qa')` no matchee este run por prefijo.
    const orderArr = path.join(tmp, 'order-array.json');
    fs.writeFileSync(orderArr, JSON.stringify([{ id: 'qaarr', goal: 'orden en array', targets: ['smoke'], scope: ['product.js'], acceptance: ['product.js exporta 2'] }]));
    const vArr = orchestra(['verify', '--worktree', ext, '--order', `@${orderArr}`, '--json'], tmp, { ...ENV, ORCHESTRA_PI_CLI: fakePi });
    const repArr = readJson(path.join(lastRun('qaarr'), 'report.json'));
    check('verify: --order @archivo con array de 1 orden → la procesa (exit 0, id real)',
      vArr.code === 0 && repArr.id === 'qaarr' && repArr.verdict === 'PASS', vArr.all.slice(-400));

    // c12) worktree ATRÁS de main: el diff debe comparar contra merge-base(base, HEAD), no contra la
    //      base directa (que traería los commits de main en reversa como borrados).
    // Avanza main en un worktree aparte: no se toca el working tree (sucio) del autor.
    const mainWt = path.join(os.tmpdir(), `orchestra-main-${process.pid}-${Date.now()}`);
    git(['worktree', 'add', '-q', mainWt, 'main'], ext);
    git(['config', 'user.email', 'verify@smoke.local'], mainWt);
    git(['config', 'user.name', 'verify-smoke'], mainWt);
    fs.writeFileSync(path.join(mainWt, 'main-only.js'), 'solo en main\n');
    git(['add', 'main-only.js'], mainWt);
    git(['commit', '-qm', 'main avanza'], mainWt);
    git(['worktree', 'remove', '--force', mainWt], ext);
    fs.rmSync(mainWt, { recursive: true, force: true });
    const vMb = runVerify({});
    const dMb = fs.readFileSync(path.join(lastRun('qa'), 'diff.patch'), 'utf8');
    check('verify: el diff usa merge-base (un worktree atrás de main no trae los commits de main en reversa)',
      vMb.code === 0 && dMb.includes('module.exports = 2') && !dMb.includes('solo en main'),
      `code=${vMb.code} has2=${dMb.includes('module.exports = 2')} hasMain=${dMb.includes('solo en main')} head=${git(['rev-parse', '--abbrev-ref', 'HEAD'], ext).out.trim()} main=${git(['rev-parse', '--short', 'main'], ext).out.trim()} mb=${git(['merge-base', 'main', 'HEAD'], ext).out.trim()} ${vMb.all.slice(-200)}`);

    // d) provider-unavailable (402 del proveedor en el verifier) → exit 3
    const v4 = runVerify({ FAKE_PI_ERROR: '402', FAKE_PI_ROLE: 'verifier' });
    const rep4 = readJson(path.join(lastRun('qa'), 'report.json'));
    check('verify: provider-unavailable → exit 3',
      v4.code === 3 && rep4.exitCode === 3 && !!rep4.providerUnavailable, v4.all.slice(-400));
  }

  // 11b) tabs en el path del índice (POSIX): NTFS prohíbe `\t` en nombres, así que el caso se prueba
  //      sobre `restoreIndex`/`lsIndexEntries` en un repo temporal; en Windows queda cubierto por
  //      `splitIndexEntry` en el self-test.
  if (process.platform !== 'win32') {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-tab-'));
    try {
      git(['init', '-q'], t2);
      git(['config', 'user.email', 'tab@smoke.local'], t2);
      git(['config', 'user.name', 'tab-smoke'], t2);
      const tabName = 'foo\tbar.ts';
      fs.writeFileSync(path.join(t2, tabName), 'version del autor\n');
      git(['add', '-A'], t2); git(['commit', '-qm', 'base'], t2);
      const idxBefore = await lsIndexEntries(t2);
      const key = [...idxBefore.keys()].find((k) => k.endsWith('\tbar.ts'));
      // Envenenar el índice (contenido malicioso + git add) y restaurar los bytes del worktree.
      fs.writeFileSync(path.join(t2, tabName), 'malicioso\n');
      git(['add', '-A'], t2);
      fs.writeFileSync(path.join(t2, tabName), 'version del autor\n');
      restoreIndex(t2, idxBefore, await lsIndexEntries(t2));
      const idxAfter = await lsIndexEntries(t2);
      check('D2: restoreIndex repone un path con tab (no lo trunca)',
        !!key && idxAfter.get(key) === idxBefore.get(key),
        `before=${JSON.stringify([...idxBefore])} after=${JSON.stringify([...idxAfter])}`);
    } finally {
      fs.rmSync(t2, { recursive: true, force: true });
    }
  }

  // 11d) cambios staged: un autor que hace `git add` no debe verse como "diff vacío".
  {
    const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-staged-'));
    const patchFile = `${t3}.patch`;
    try {
      git(['init', '-q'], t3);
      git(['config', 'user.email', 'staged@smoke.local'], t3);
      git(['config', 'user.name', 'staged-smoke'], t3);
      fs.writeFileSync(path.join(t3, 'base.txt'), 'base\n');
      git(['add', '-A'], t3); git(['commit', '-qm', 'base'], t3);
      fs.writeFileSync(path.join(t3, 'nuevo.test.ts'), 'test nuevo\n');
      fs.writeFileSync(path.join(t3, 'base.txt'), 'base editado\n');
      git(['add', '-A'], t3);
      const changed = await changedFiles(t3);
      const patch = await writeDiff(t3, patchFile);
      check('changedFiles/writeDiff ven los cambios staged (no "diff vacío")',
        changed.includes('nuevo.test.ts') && changed.includes('base.txt') && /nuevo\.test\.ts/.test(patch),
        `changed=${JSON.stringify(changed)}`);
    } finally {
      fs.rmSync(t3, { recursive: true, force: true });
      fs.rmSync(patchFile, { force: true });
    }
  }

  // 11c) baseline rojo (P00098): el resumen muestra el id real aunque el state no tenga `result`, y
  //      `--fresh` re-despacha desde cero sin reanudar el state viejo.
  {
    const cfgPathR = path.join(O, 'config.json');
    const cRed = readJson(cfgPathR);
    const gatesBackup = cRed.gates;
    cRed.gates = { ...cRed.gates, red: ['node -e "process.exit(1)"'] };
    fs.writeFileSync(cfgPathR, JSON.stringify(cRed, null, 2));
    const order = (id) => JSON.stringify({ id, title: 'baseline rojo', goal: 'x', targets: ['red'], scope: ['src/r.js'], acceptance: ['nada'] });
    const env = { ...ENV, ORCHESTRA_PI_CLI: fakePi };
    const stRed = path.join(O, 'runs', 'qa-rojo', 'state.json');

    // 1) un run humano: el resumen debe traer el id real (antes salía `undefined`).
    const rRed1 = orchestra(['dispatch', '--order', order('qa-rojo')], tmp, env);
    const s1 = readJson(stRed);
    check('baseline rojo: resumen con id real y needs-decision',
      /qa-rojo\s+needs-decision/.test(rRed1.all) && s1.status === 'needs-decision' && s1.decision?.reason === 'gate-baseline-rojo',
      rRed1.all.slice(-500));

    // 2) en --json, results[0].id también es el real.
    const rRed2 = orchestra(['dispatch', '--order', order('qa-rojo'), '--json'], tmp, env);
    let jRed2 = null; try { jRed2 = JSON.parse(rRed2.out).results[0]; } catch { /* noop */ }
    check('baseline rojo: --json results[0].id real', jRed2?.id === 'qa-rojo' && jRed2?.status === 'needs-decision', rRed2.out.slice(-300));

    // 3) sin --fresh reanuda el state viejo (la marca sobrevive).
    const stOld = readJson(stRed);
    stOld.markerViejo = 'si';
    fs.writeFileSync(stRed, JSON.stringify(stOld, null, 2));
    const rResume = orchestra(['dispatch', '--order', order('qa-rojo'), '--json'], tmp, env);
    let jResume = null; try { jResume = JSON.parse(rResume.out).results[0]; } catch { /* noop */ }
    check('re-dispatch sin --fresh reanuda el state viejo (marca intacta)',
      readJson(stRed).markerViejo === 'si' && jResume?.status === 'needs-decision', rResume.out.slice(-300));

    // 4) con --fresh arranca de cero: la marca desaparece y se decide de nuevo.
    const rFresh = orchestra(['dispatch', '--order', order('qa-rojo'), '--fresh', '--json'], tmp, env);
    let jFresh = null; try { jFresh = JSON.parse(rFresh.out).results[0]; } catch { /* noop */ }
    check('--fresh re-despacha desde cero (no reanuda el state viejo)',
      readJson(stRed).markerViejo === undefined && jFresh?.id === 'qa-rojo' && jFresh?.status === 'needs-decision',
      rFresh.all.slice(-500));

    fs.writeFileSync(cfgPathR, JSON.stringify({ ...readJson(cfgPathR), gates: gatesBackup }, null, 2));
  }

  // 12. D4: bookkeeping 'external' — un ciclo completo NO toca STATE.md ni tasks.json y el commit
  //     de integración NO incluye archivos de .orchestra/.
  {
    const cfgE = readJson(cfgPath);
    cfgE.bookkeeping = 'external';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgE, null, 2));
    const stateBefore = fs.readFileSync(path.join(O, 'STATE.md'), 'utf8');
    const tasksBefore = fs.readFileSync(path.join(O, 'tasks.json'), 'utf8');
    const orderE = JSON.stringify({ id: 'bk-ext', goal: 'ciclo con bookkeeping external', targets: ['smoke'], scope: ['src/z.js'], acceptance: ['existe el cambio'] });
    const rE = orchestra(['dispatch', '--order', orderE, '--commit', '--json'], tmp, { ...ENV, ORCHESTRA_PI_CLI: fakePi });
    let jE = null; try { jE = JSON.parse(rE.out); } catch { /* noop */ }
    check('bookkeeping external: ciclo completo integra (status ok)',
      !!jE && jE.status === 'ok' && jE.results?.[0]?.integration?.ok === true, rE.all.slice(-500));
    check('bookkeeping external: no toca STATE.md ni tasks.json',
      fs.readFileSync(path.join(O, 'STATE.md'), 'utf8') === stateBefore
      && fs.readFileSync(path.join(O, 'tasks.json'), 'utf8') === tasksBefore,
      rE.all.slice(-300));
    check('bookkeeping external: no corre el scribe',
      !fs.existsSync(path.join(O, 'runs', 'bk-ext', 'scribe.json')));
    const merged = git(['diff', '--name-only', 'HEAD^1', 'HEAD'], tmp).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    check('bookkeeping external: el commit de integración excluye .orchestra/ e incluye el cambio',
      merged.length > 0 && merged.some((f) => f.includes('fake-change')) && !merged.some((f) => f.startsWith('.orchestra/')),
      merged.join(', '));

    // 12b. orchestra reject NO toca tasks.json en modo external
    const tasksBefore2 = fs.readFileSync(path.join(O, 'tasks.json'), 'utf8');
    const rej = orchestra(['reject', '--task', 'bk-ext', '--reason', 'test', '--json'], tmp, { ...ENV, ORCHESTRA_PI_CLI: fakePi });
    check('bookkeeping external: reject no crea tasks.json',
      fs.readFileSync(path.join(O, 'tasks.json'), 'utf8') === tasksBefore2, rej.all.slice(-300));
  }

  // 7. self-test del driver
  const st = orchestra(['--self-test'], tmp, ENV);
  check('--self-test pasa', st.code === 0, st.out.slice(-200));
} catch (e) {
  check('smoke no lanzó excepción', false, e?.stack || String(e));
} finally {
  // limpieza: worktree prune + borrar temporal
  git(['worktree', 'prune'], tmp);
  if (ext) fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? `\n    ${r.extra.split('\n').slice(0, 6).join('\n    ')}` : ''}`);
console.log(`\nsmoke: ${results.length - failed.length}/${results.length} OK`);
process.exit(failed.length ? 1 : 0);
