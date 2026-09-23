/** Reporte del ledger: costo por rol/modelo/tarea. */
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, LEDGER } from './paths.mjs';
import { exists, readJson, safeReaddir, now } from './util.mjs';

export function readLedger() {
  if (!exists(LEDGER)) return [];
  const out = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* línea parcial por interrupción */ }
  }
  return out;
}

/** Agrega el ledger: costo/llamadas por modelo, rol y tarea. */
export function summarizeLedger(entries) {
  const byModel = {}; const byRole = {}; const byTask = {};
  let cost = 0; let turns = 0; let exhausted = 0; let gateFails = 0;
  for (const e of entries || []) {
    cost += e.cost || 0;
    turns += e.turns || 0;
    if (e.exhausted) exhausted++;
    if (e.role === 'gate' && e.ok === false) gateFails++;
    if (e.model) {
      if (!byModel[e.model]) byModel[e.model] = { calls: 0, cost: 0 };
      byModel[e.model].calls++; byModel[e.model].cost += e.cost || 0;
    }
    if (e.role) {
      if (!byRole[e.role]) byRole[e.role] = { calls: 0, cost: 0 };
      byRole[e.role].calls++; byRole[e.role].cost += e.cost || 0;
    }
    if (e.task) {
      if (!byTask[e.task]) byTask[e.task] = { calls: 0, cost: 0, authorCycles: 0 };
      byTask[e.task].calls++; byTask[e.task].cost += e.cost || 0;
      if (e.role === 'author') byTask[e.task].authorCycles++;
    }
  }
  return { events: (entries || []).length, cost: Number(cost.toFixed(6)), turns, exhausted, gateFails, byModel, byRole, byTask };
}

export function taskStates() {
  const states = {};
  for (const e of safeReaddir(RUNS)) {
    if (!e.isDirectory()) continue;
    const p = path.join(RUNS, e.name, 'state.json');
    if (!exists(p)) continue;
    try { const s = readJson(p); states[e.name] = { status: s.status, spentUsd: s.spentUsd || 0, cycle: s.cycle || 0 }; } catch { /* ignorar */ }
  }
  return states;
}

export function reportCommand(args) {
  const summary = summarizeLedger(readLedger());
  const doc = { generatedAt: now(), ...summary, states: taskStates() };
  if (args.json) { console.log(JSON.stringify(doc, null, 2)); return doc; }

  console.log('RESUMEN (.orchestra/ledger.jsonl)');
  console.log(`  eventos ${summary.events} | costo $${summary.cost.toFixed(4)} | turns ${summary.turns} | keys agotadas ${summary.exhausted} | gates rojos ${summary.gateFails}`);
  const table = (title, obj, extra) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return;
    console.log(`\n  ${title}`);
    for (const k of keys.sort((a, b) => obj[b].cost - obj[a].cost)) {
      const v = obj[k];
      console.log(`    ${k.padEnd(30)} ${String(v.calls ?? '').padStart(4)} llamadas  $${(v.cost || 0).toFixed(4)}${extra ? '  ' + extra(k, v) : ''}`);
    }
  };
  table('por rol', summary.byRole);
  table('por modelo', summary.byModel);
  table('por tarea', summary.byTask, (k) => (doc.states[k] ? `estado=${doc.states[k].status} ciclos=${doc.states[k].cycle}` : ''));
  const pending = Object.entries(doc.states).filter(([, s]) => s.status !== 'approved');
  if (pending.length) console.log(`\n  sin aprobar: ${pending.map(([k, s]) => `${k} (${s.status})`).join(', ')}`);
  return doc;
}
