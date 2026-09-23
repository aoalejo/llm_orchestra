/**
 * Dashboard del orchestrator: vista de costos, tareas, cuota y worktrees.
 *
 * Fase 1: `orchestra dashboard [--interval 2] [--once] [--plain] [--json]`.
 *   - default: frame full-screen ANSI redibujado cada `--interval` segundos.
 *   - `--once` / no-TTY / `--json`: una sola salida.
 *   - `--plain`: líneas sin ANSI (para widgets/paneles).
 *
 * La data sale del ledger + state.json + /usage + git. Los renderers son puros
 * (testeables) y reciben el objeto de `gatherDashboard`.
 */
import path from 'node:path';
import process from 'node:process';
import { O, ROOT, RUNS } from './paths.mjs';
import { exists, readJson, safeReaddir } from './util.mjs';
import { runProcess } from './runner.mjs';
import { readLedger, summarizeLedger } from './report.mjs';
import { usageSnapshot } from './usage.mjs';
import { maxAgeHoursOf } from './models.mjs';

function parseWorktrees(porcelain) {
  const out = [];
  let cur = {};
  for (const line of String(porcelain || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { if (cur.path) out.push(cur); cur = { path: line.slice(9).trim() }; }
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
  }
  if (cur.path) out.push(cur);
  return out;
}

export async function gatherDashboard(config, { withUsage = true } = {}) {
  const summary = summarizeLedger(readLedger());
  const tasks = [];
  for (const e of safeReaddir(RUNS)) {
    if (!e.isDirectory()) continue;
    const sf = path.join(RUNS, e.name, 'state.json');
    if (!exists(sf)) continue;
    try {
      const s = readJson(sf);
      tasks.push({
        id: e.name, status: s.status, cycle: s.cycle || 0,
        cost: Number((s.spentUsd || 0).toFixed(6)), approved: !!s.approved,
        decision: s.decision || null, result: s.result || null,
      });
    } catch { /* state corrupto */ }
  }
  let backlog = [];
  try { backlog = (readJson(path.join(O, 'tasks.json')).tasks || []).map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk })); } catch { /* noop */ }
  const wt = await runProcess('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT });
  const br = await runProcess('git', ['branch', '--list', 'orchestra/*', '--format=%(refname:short)'], { cwd: ROOT });
  let models = null;
  const mg = path.join(O, 'models.generated.json');
  if (exists(mg)) {
    try { const g = readJson(mg); models = { generatedAt: g.generatedAt, author: g.author || [], escalation: g.escalationAuthor || null, pins: g.pins || [] }; } catch { /* noop */ }
  }
  const usage = withUsage ? await usageSnapshot(config, { includeWorkers: true }) : [];
  return {
    ts: new Date().toISOString(),
    summary,
    tasks,
    backlog,
    worktrees: parseWorktrees(wt.out),
    branches: (br.out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    models,
    maxAgeHours: maxAgeHoursOf(config),
    usage,
  };
}

const money = (n) => `$${Number(n || 0).toFixed(4)}`;
const statusMark = (s) => (s === 'approved' ? '✓' : s === 'done' ? '✓' : s === 'needs-approval' ? '⏳' : s === 'needs-decision' ? '❓' : s === 'failed' ? '✗' : '·');

/** Líneas compactas sin ANSI (para widget dentro de pi). */
export function renderDashboardPlain(data) {
  const s = data.summary || {};
  const lines = [`orchestra · ${money(s.cost)} · ${s.events || 0} ev · gates✗ ${s.gateFails || 0} · keys✗ ${s.exhausted || 0}`];
  const active = (data.tasks || []).filter((t) => t.status !== 'approved' || !t.approved);
  const tasks = (active.length ? active : data.tasks || []).slice(-6);
  if (tasks.length) {
    lines.push(tasks.map((t) => `${statusMark(t.status)}${t.id}(${money(t.cost)})`).join('  ') + (active.some((t) => t.decision) ? '  ⚠ decisión pendiente' : ''));
  }
  const usage = data.usage || [];
  if (usage.length) {
    lines.push(usage.map((u) => {
      const p = u.usage ? `r${u.usage.rolling?.percent ?? '-'}%/w${u.usage.weekly?.percent ?? '-'}%` : 'n/d';
      return `${(u.role === 'orchestrator' ? 'A' : 'B')}:${p}`;
    }).join('  '));
  }
  return lines;
}

/** Frame completo con secciones (ANSI mínimo). */
export function renderDashboard(data, { width = 100 } = {}) {
  const s = data.summary || {};
  const hr = '─'.repeat(Math.max(20, Math.min(width, 100)));
  const out = [];
  out.push(`ORCHESTRA  ·  ${data.ts}`);
  out.push(hr);
  out.push(`COSTO ${money(s.cost)}   turns ${s.turns || 0}   eventos ${s.events || 0}   gates rojos ${s.gateFails || 0}   keys agotadas ${s.exhausted || 0}`);

  const table = (title, obj, extra) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return;
    out.push('');
    out.push(title);
    for (const k of keys.sort((a, b) => (obj[b].cost || 0) - (obj[a].cost || 0)).slice(0, 8)) {
      const v = obj[k];
      out.push(`  ${String(k).padEnd(30)} ${String(v.calls ?? '').padStart(4)} ll  ${money(v.cost)}${extra ? '  ' + extra(k, v) : ''}`);
    }
  };
  table('POR ROL', s.byRole);
  table('POR MODELO', s.byModel);

  out.push('');
  out.push(`TAREAS (${(data.tasks || []).length})`);
  for (const t of (data.tasks || []).slice(-10)) {
    const dec = t.decision ? `  ❓ ${t.decision.reason}` : '';
    const v = t.result?.verdict ? ` ${t.result.verdict}` : '';
    out.push(`  ${statusMark(t.status)} ${String(t.id).padEnd(24)} ${String(t.status).padEnd(15)} ${String(t.cycle).padStart(2)} ciclos  ${money(t.cost)}${v}${dec}`);
  }

  if ((data.usage || []).length) {
    out.push('');
    out.push('CUOTA');
    for (const u of data.usage) {
      const g = u.usage;
      out.push(`  ${String(u.role).padEnd(13)} ${String(u.name).padEnd(30)} ${g ? `rolling ${g.rolling?.percent ?? '-'}%  weekly ${g.weekly?.percent ?? '-'}%  monthly ${g.monthly?.percent ?? '-'}%` : 'sin datos'}`);
    }
  }

  if ((data.worktrees || []).length || (data.branches || []).length) {
    out.push('');
    out.push(`WORKTREES (${(data.worktrees || []).length})`);
    for (const w of data.worktrees) out.push(`  ${w.branch || '?'}  ${w.path}`);
    if ((data.branches || []).length) out.push(`  RAMAS: ${data.branches.join(', ')}`);
  }

  if (data.models) {
    out.push('');
    const ageH = ((Date.now() - new Date(data.models.generatedAt).getTime()) / 3600e3).toFixed(1);
    out.push(`MODELOS  author: ${(data.models.author || []).join(', ')}  ·  refresh a las ${data.maxAgeHours} h (hace ${ageH} h)`);
    if ((data.models.pins || []).length) out.push(`  pins: ${data.models.pins.join(', ')}`);
  }
  out.push(hr);
  out.push('Ctrl+C para salir');
  return out;
}

export async function runDashboard(args, config) {
  const once = !!args.once || !!args.json || !process.stdout.isTTY;
  const plain = !!args.plain;
  const interval = Math.max(1, Number(args.interval) || 2) * 1000;

  const draw = async () => {
    const data = await gatherDashboard(config, { withUsage: !args.noUsage });
    if (args.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
    if (plain) { process.stdout.write(renderDashboardPlain(data).join('\n') + '\n'); return; }
    const frame = renderDashboard(data, { width: process.stdout.columns || 100 }).join('\n');
    process.stdout.write('\x1b[2J\x1b[H' + frame + '\n');
  };

  if (once) { await draw(); return; }
  process.stdout.write('\x1b[?25l');   // ocultar cursor
  await draw();
  const timer = setInterval(() => { draw().catch(() => {}); }, interval);
  await new Promise((resolve) => {
    const stop = () => { clearInterval(timer); process.stdout.write('\x1b[?25h\x1b[2J\x1b[H'); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
