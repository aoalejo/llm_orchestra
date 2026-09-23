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
const ENV = { ...process.env, ORCHESTRA_STUB_TOUCH: '1', ORCHESTRA_RUNNER: '', ORCHESTRA_PI_CLI: '', ORCHESTRA_AGENTS_DIR: '' };
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

  // 3. protegida sin --yes → no integra
  const prot = orchestra(['--task', 't3', '--stub', '--commit'], tmp, ENV);
  check('protegida sin --yes avisa', /ruta protegida/i.test(prot.all), prot.all.slice(-400));
  check('protegida sin --yes no commitea', commitCount(tmp) === base, `${commitCount(tmp)} vs ${base}`);
  check('protegida sin --yes no marca done', readJson(path.join(O, 'tasks.json')).tasks.find((t) => t.id === 't3').status !== 'done');

  // 4. protegida con --yes → integra de verdad (state fresco para que corra el author)
  fs.rmSync(path.join(O, 'runs', 't3'), { recursive: true, force: true });
  const protYes = orchestra(['--task', 't3', '--stub', '--commit', '--yes'], tmp, ENV);
  const afterYes = commitCount(tmp);
  check('protegida con --yes integra (commit + merge)', protYes.code === 0 && afterYes - base === 2, `${afterYes - base} commits (esperados 2)\n${protYes.out.slice(-300)}`);
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
  check('--all commitea por tarea (commit + merge --no-ff)', afterAll - beforeAll === 4, `${afterAll - beforeAll} commits (esperados 4)`);
  check('--all no deja worktrees ni ramas', worktreesLeft(tmp) === 0 && branches(tmp) === '', `wt=${worktreesLeft(tmp)} br=${branches(tmp)}`);
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

  // 8. modo chat: scout / dispatch / status / approve
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

  const appr = orchestra(['approve', '--task', 'chat1', '--commit', '--stub', '--json'], tmp, ENV);
  check('approve integra (commit + merge)', (() => {
    try { const j = JSON.parse(appr.out); return j.approved === true && j.integration?.ok === true && commitCount(tmp) - beforeChat === 2; } catch { return false; }
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
    try { const j = JSON.parse(batch.out); return j.results.length === 2 && j.results.every((r) => r.approved) && commitCount(tmp) - beforeBatch === 4; } catch { return false; }
  })(), batch.out.slice(0, 500));
  const doneAfterBatch = readJson(path.join(O, 'tasks.json')).tasks.filter((t) => t.status === 'done').map((t) => t.id);
  check('dispatch multi-orden marca done', doneAfterBatch.includes('b1') && doneAfterBatch.includes('b2'), doneAfterBatch.join(','));
  check('dispatch multi-orden limpia worktrees', worktreesLeft(tmp) === 0 && branches(tmp) === '', `wt=${worktreesLeft(tmp)} br=${branches(tmp)}`);

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

  // 7. self-test del driver
  const st = orchestra(['--self-test'], tmp, ENV);
  check('--self-test pasa', st.code === 0, st.out.slice(-200));
} catch (e) {
  check('smoke no lanzó excepción', false, e?.stack || String(e));
} finally {
  // limpieza: worktree prune + borrar temporal
  git(['worktree', 'prune'], tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? `\n    ${r.extra.split('\n').slice(0, 6).join('\n    ')}` : ''}`);
console.log(`\nsmoke: ${results.length - failed.length}/${results.length} OK`);
process.exit(failed.length ? 1 : 0);
