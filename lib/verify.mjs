/**
 * Verificación independiente (P00096):
 *
 *   orchestra verify --worktree <ruta> --order <json|@archivo> [--base <ref>]
 *
 * QA sobre un worktree que NO creó Orchestra (lo escribió otro autor, p. ej. otro agente):
 * corre los gates de `order.targets` (config.gates) en ese worktree, después los verificadores
 * configurados (mismo prompt agents/verifier.md, mismas guardas de sólo lectura, contra-tests en
 * .orchestra/scratch) sobre el diff `base...HEAD` (default: main) MÁS los cambios sin commitear.
 *
 * No crea worktrees, no commitea, no mergea y no toca tasks.json. Al terminar aplica la guarda de
 * permisos D2: compara `git status --porcelain` antes/después del verifier y revierte todo lo que
 * él tocó salvo `zz-qa-*` (reportándolo como violación). Salida: runs/verify-<id>-<ts>/report.{md,json}
 * y exit 0 PASS / 1 FAIL / 2 violación / 3 provider-unavailable.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, SCRATCH } from "./paths.mjs";
import { ensureDir, now, writeJson } from "./util.mjs";
import { log, warn, die } from "./log.mjs";
import {
  extractLastJson, workOrderText, modelCallOpts, normalizeWorkOrder, validateWorkOrder,
  gateCommands, normalizeVerdict, noUsableVerdict, compactFindings, keysMode,
} from "./pure.mjs";
import { readAgent } from "./agents.mjs";
import { pickKey } from "./keys.mjs";
import { callModel, runGate, runProcess } from "./runner.mjs";

/** Mismo prompt y mismo contrato que el loop: `cycleDir/diff.patch` + `gate.log`, cwd = worktree. */
export async function callVerifier(ctx, task, model, agentName, suffix, cycleDir, extra = '') {
  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  const out = await callModel({
    runner: ctx.runner, pi: ctx.pi, ...modelCallOpts(ctx.config, model), apiKey: key?.value,
    systemPrompt: readAgent(agentName),
    prompt: `WORK ORDER:\n${workOrderText(task, { workdir: ctx.workdir })}\n\nDIFF: ${path.join(cycleDir, 'diff.patch')}\nGate log: ${path.join(cycleDir, 'gate.log')}\nZona de counter-tests (absoluta): ${SCRATCH}\n\nDevolvé el verdict JSON.${extra ? `\n${extra}` : ''}`,
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, `verdict-${suffix}.json`), cwd: ctx.workdir, role: agentName,
    timeoutMs: ctx.config.loop?.verifierTimeoutMs,
  });
  if (out.exhausted && key) ctx.keyState.exhausted.add(key.name);
  return { verdict: extractLastJson(out.text), out, key };
}

/* ──────────────── guarda de permisos D2 (snapshot antes/después) ──────────────── */

// ponytail: techo de 5MB por archivo para la copia baseline; un archivo más grande no se copia y
// sólo se reporta (nunca se pisa el trabajo del autor con `git checkout` si estaba sucio antes).
const QA_FILE_MAX = 5 * 1024 * 1024;

function hashPath(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return 'dir';
    if (st.size > QA_FILE_MAX) return `size:${st.size}`;
    return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } catch { return 'missing'; }
}

/** Parsea `git status --porcelain=v1 -z` (NUL-separated, sin C-style quoting). */
async function porcelain(cwd) {
  const r = await runProcess('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd });
  const out = [];
  const data = String(r.out || '');
  if (!data) return out;

  // -z = NUL-separated: cada entrada es "XY path\0"; en renames hay dos paths: "XY newpath\0origpath\0"
  const entries = data.split('\0').filter(Boolean);
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.length < 3) { i++; continue; }  // malformed
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    out.push({ status, path });
    // Renames (R) y Copies (C), en X o en Y: en -z el token SIGUIENTE es siempre la ruta original (sin prefijo
    // de estado). El original se registra como borrado para la guarda D2.
    if (/[RC]/.test(status) && i + 1 < entries.length) {
      const origPath = entries[i + 1];
      out.push({ status: 'D ', path: origPath });  // marcar el original como deletado
      i += 2;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Snapshot D2: path → hash de contenido de cada archivo sucio/no trackeado del worktree. */
export async function qaSnapshot(cwd) {
  const snap = {};
  for (const e of await porcelain(cwd)) snap[e.path] = hashPath(path.join(cwd, e.path));
  return snap;
}

/**
 * Compara los snapshots antes/después del verifier (D2): lo creado o con contenido distinto lo
 * tocó él. `zz-qa-*` (y la zona de scratch) es permitido SOLO si lo creó el verifier (no existía antes).
 * Si existía antes, es una violación. Puro y testeable: { path: hash } → { touched, kept, violations }.
 * trackedBefore: set de rutas que estaban tracked en HEAD antes (para detectar zz-qa pre-existentes).
 */
export function qaDiff(before = {}, after = {}, trackedBefore = new Set()) {
  const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((p) => before[p] === undefined || after[p] === undefined || before[p] !== after[p]);
  const permitido = (p) => {
    const u = String(p).replace(/\\/g, '/');
    const basename = path.basename(u);
    const isZzQa = basename.startsWith('zz-qa-');
    const isScratch = u.startsWith('.orchestra/scratch/');
    // zz-qa-* y scratch sólo permitidos si los CREÓ el verifier (no existían antes ni sucios ni tracked)
    if (isZzQa || isScratch) return before[p] === undefined && !trackedBefore.has(p);
    return false;
  };
  return { touched, kept: touched.filter(permitido), violations: touched.filter((p) => !permitido(p)) };
}

/** Copia los archivos sucios antes del verifier: así se restaura el estado exacto del autor. */
function saveBaseline(cwd, snap, dir) {
  for (const p of Object.keys(snap)) {
    const src = path.join(cwd, p);
    try {
      const st = fs.statSync(src);
      if (!st.isFile() || st.size > QA_FILE_MAX) continue;
      const dst = path.join(dir, p);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch { /* ya no existe o ilegible: queda sólo en el reporte */ }
  }
}

/**
 * Revierte lo que el verifier tocó (D2), path por path — nunca `-A`:
 *  - estaba sucio antes → se restaura la copia baseline (el trabajo del autor NO se pisa);
 *  - estaba limpio (trackeado) → `git reset -- <p>` (unstage) + `git checkout -- <p>`;
 *  - era nuevo (no trackeado) → se borra.
 */
async function qaRestore(cwd, before, baselineDir, violations) {
  const actions = [];

  // Restaurar cada path violado: unstage + restore desde baseline o del índice
  for (const p of violations) {
    if (before[p] !== undefined) {
      // Estaba sucio: restore desde baseline (el trabajo del autor)
      const base = path.join(baselineDir, p);
      if (fs.existsSync(base)) {
        // Primero unstage
        await runProcess('git', ['reset', '-q', '--', p], { cwd });
        // Luego restore la copia baseline
        fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true });
        fs.copyFileSync(base, path.join(cwd, p));
        actions.push({ path: p, action: 'restaurado-al-estado-del-autor' });
      } else {
        actions.push({ path: p, action: 'reportado-sin-restaurar' });   // oversized: no se pisa al autor
      }
    } else {
      // Era limpio/trackeado: unstage + git checkout
      await runProcess('git', ['reset', '-q', '--', p], { cwd });
      const c = await runProcess('git', ['checkout', '--', p], { cwd });
      if (c.code === 0) actions.push({ path: p, action: 'git-checkout' });
      else {
        await fs.promises.rm(path.join(cwd, p), { recursive: true, force: true });
        actions.push({ path: p, action: 'borrado' });
      }
    }
  }
  return actions;
}

/** Los `git add -A -N` (para que el diff incluya no trackeados) dejan intent-to-add: se deshacen. */
async function unstageIntent(cwd, paths) {
  if (paths.length) await runProcess('git', ['reset', '-q', '--', ...paths], { cwd });
}

/** Entradas del índice (`git ls-files -s -z`): Map "<stage>\t<path>" → "<mode> <sha>". */
export async function lsIndexEntries(cwd) {
  const out = String((await runProcess('git', ['ls-files', '-s', '-z'], { cwd })).out || '');
  const m = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    m.set(`${stage}\t${rec.slice(tab + 1)}`, `${mode} ${sha}`);
  }
  return m;
}

export function sameIndex(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Repone en el índice las entradas que difieren de `before` (y saca las que no estaban) con
 * `git update-index --index-info`. No se copia el archivo de índice entero: traería el stat cacheado viejo
 * (tamaño/mtime) y git da por modificado sin mirar el contenido un archivo cuyo tamaño cacheado no coincide
 * (p. ej. restaurado con CRLF por core.autocrlf). Las entradas de --index-info no traen stat → git compara contenido.
 */
export function restoreIndex(cwd, before, now) {
  const lines = [];
  for (const [k, v] of before) if (now.get(k) !== v) { const [stage, p] = k.split('\t'); const [mode, sha] = v.split(' '); lines.push(`${mode} ${sha} ${stage}\t${p}`); }
  for (const k of now.keys()) if (!before.has(k)) { const [stage, p] = k.split('\t'); lines.push(`0 ${'0'.repeat(40)} ${stage}\t${p}`); }
  if (!lines.length) return 0;
  const r = spawnSync('git', ['update-index', '-z', '--index-info'], { cwd, input: lines.join('\0') + '\0' });
  if (r.status !== 0) warn(`verify: no se pudo restaurar el índice: ${String(r.stderr || '').trim().slice(0, 200)}`);
  return lines.length;
}

/* ──────────────────────────────── comando verify ──────────────────────────────── */

function reportMd(r) {
  const L = [`# verify · ${r.id}`, ''];
  L.push(`- **veredicto**: ${r.verdict} (exit ${r.exitCode})`);
  L.push(`- worktree: \`${r.worktree}\` · base: \`${r.base}\``);
  L.push(`- ts: ${r.ts} · costo≈$${r.cost}`, '');
  L.push('## Gates', '');
  if (!r.gates.results.length) L.push('(sin gates configurados)', '');
  else {
    for (const g of r.gates.results) L.push(`- ${g.passed ? '✓' : '✗'} \`${g.command}\` → exit ${g.code}`);
    L.push('');
  }
  L.push('## Verificadores', '');
  if (!r.verifiers.length) L.push('(ninguno corrió)', '');
  for (const v of r.verifiers) L.push(`- ${v.model}: **${v.verdict}** (${(v.findings || []).length} findings) · ${v.log}`);
  if (r.verifiers.length) L.push('');
  if (r.findings.length) {
    L.push('## Findings', '');
    for (const f of r.findings) L.push(`- [${f.severity}] ${f.file ?? '-'}${f.line != null ? ':' + f.line : ''} — ${f.problem}`);
    L.push('');
  }
  if (r.providerUnavailable) {
    L.push('## Proveedor no disponible', '',
      `- ${r.providerUnavailable.model ?? '(sin modelo)'}: ${r.providerUnavailable.reason}${r.providerUnavailable.class ? ` (${r.providerUnavailable.class})` : ''}`, '');
  }
  L.push('## Violaciones de permisos (D2)', '');
  if (!r.violations.length) L.push('(ninguna)', '');
  else {
    for (const v of r.violations) L.push(`- \`${v.path}\` → ${v.action}`);
    L.push('');
  }
  if (r.kept.length) {
    L.push('## Conservados (permitidos)', '');
    for (const k of r.kept) L.push(`- \`${k}\``);
    L.push('');
  }
  L.push('## Artefactos', '',
    '- `diff.patch` — diff base…HEAD + cambios sin commitear',
    '- `gate.log` — salida de los gates',
    '- `verdict-*.json` — salida cruda de cada verifier',
    '- `baseline/` — copias previas usadas para restaurar');
  return L.join('\n') + '\n';
}

export async function verifyCommand(args, config, deps) {
  if (!args.worktree) die('verify: falta --worktree <ruta del worktree externo>');
  if (!args.order?.length) die('verify: falta --order <json|@archivo>');
  const wt = path.resolve(args.worktree);
  if ((await runProcess('git', ['rev-parse', '--git-dir'], { cwd: wt })).code !== 0) {
    die(`verify: ${wt} no es un worktree/repo git`);
  }

  let raw = null;
  try {
    const first = String(args.order[0]);
    raw = JSON.parse(first.startsWith('@') ? fs.readFileSync(first.slice(1), 'utf8') : first);
  } catch (e) { die(`verify: --order no es JSON válido: ${e.message}`); }
  if (args.order.length > 1) warn('verify: sólo se procesa el primer --order');
  const wo = normalizeWorkOrder(raw, {});
  const errs = validateWorkOrder(wo);
  if (errs.length) die(`verify: orden inválida: ${errs.join(', ')}`);

  const base = args.base || 'main';
  const runDir = path.join(RUNS, `verify-${wo.id}-${now().replace(/[:.]/g, '-')}`);
  ensureDir(runDir);
  log(`verify ${wo.id}: worktree ${wt} · base ${base}`);

  // 1) gates de order.targets, en el worktree externo (con runner stub no corren, como el loop).
  let gates;
  if (deps.runner === 'stub') gates = { ok: true, results: [], skipped: true };
  else gates = await runGate(gateCommands(config, wo), path.join(runDir, 'gate.log'), wt,
    config.gates?.timeoutMs || config.loop?.gateTimeoutMs || 20 * 60 * 1000);
  if (!gates.ok) warn(`verify: gates ROJOS en ${wo.targets?.join(', ') || '(todos)'} → FAIL sin verificar`);

  // 2) diff base…HEAD + cambios sin commitear (con intent-to-add para incluir no trackeados, como writeDiff).
  const untrackedPre = (await porcelain(wt)).filter((e) => e.status.startsWith('??')).map((e) => e.path);
  await runProcess('git', ['add', '-A', '-N'], { cwd: wt });
  const hasBase = (await runProcess('git', ['rev-parse', '--verify', base], { cwd: wt })).code === 0;
  if (!hasBase) warn(`verify: no existe la ref "${base}" en el worktree; el diff es sólo contra HEAD`);
  const d = await runProcess('git', ['diff', '--no-color', hasBase ? base : 'HEAD'], { cwd: wt });
  fs.writeFileSync(path.join(runDir, 'diff.patch'), d.out || '');

  // 3) verificadores (sólo con gates verdes) + guarda D2.
  const res = {
    id: wo.id, worktree: wt, base, ts: now(), verdict: 'FAIL', exitCode: 1,
    gates: { ok: gates.ok, skipped: !!gates.skipped, results: gates.results || [], log: path.join(runDir, 'gate.log') },
    verifiers: [], findings: [], providerUnavailable: null, violations: [], kept: [], cost: 0,
    artifacts: { dir: runDir, diff: 'diff.patch', reportMd: 'report.md', reportJson: 'report.json' },
  };

  if (gates.ok) {
    const before = await qaSnapshot(wt);
    const baselineDir = path.join(runDir, 'baseline');
    saveBaseline(wt, before, baselineDir);
    // Snapshot HEAD SHA antes del verifier para detectar commits posteriores
    const headBeforeResult = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: wt });
    const headBefore = (headBeforeResult.out || '').trim();
    // Rama actual ('' si detached) y valor de cada ref: para reponer la rama si el verifier hace checkout/commit.
    const symBefore = String((await runProcess('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: wt })).out || '').trim();
    const refsBefore = new Map(String((await runProcess('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: wt })).out || '')
      .split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.lastIndexOf(' ')), l.slice(l.lastIndexOf(' ') + 1)]));
    // Snapshot de archivos trackeados en HEAD (para detectar zz-qa-* pre-existentes)
    const trackedResult = await runProcess('git', ['ls-files', '-z'], { cwd: wt });
    const trackedBefore = new Set((trackedResult.out || '').split('\0').filter(Boolean));
    // Índice (staging) del autor: entradas `git ls-files -s`. El verifier puede envenenarlo sin tocar los bytes
    // del worktree (escribir, `git add`, restaurar los bytes) y eso no lo ve el snapshot de contenido. Al final
    // se reponen las entradas que difieran (ver restoreIndex) y, si el verifier las cambió, es violación.
    const indexBefore = await lsIndexEntries(wt);

    const pool = (Array.isArray(config.roles?.verifier) ? config.roles.verifier : [config.roles?.verifier]).filter(Boolean);
    if (!pool.length) die('verify: config.roles.verifier no tiene modelos');
    const risky = (config.loop?.highRiskLevels || ['high', 'critical']).includes(String(wo.risk || ''));
    const modelos = risky && config.loop?.doubleVerifyHighRisk !== false && pool[1] ? [pool[0], pool[1]] : [pool[0]];
    const extra = 'Permisos QA en el worktree: sólo podés crear archivos cuyo nombre empiece con "zz-qa-" '
      + '(dentro del worktree) y usar la zona de counter-tests de arriba; cualquier otra modificación '
      + 'del worktree se revierte y se reporta como violación.';
    const ctx = { ...deps, workdir: wt };

    const sinKeys = deps.runner !== 'stub' && keysMode(config) !== 'pi-auth' && !pickKey(config, deps.keyState, 'worker');
    if (sinKeys) {
      res.providerUnavailable = { model: null, reason: 'keys-exhausted', class: 'keys', attempts: 1, provider: null, message: 'sin keys de worker disponibles' };
      warn('verify: sin keys de worker → provider-unavailable');
    }

    const used = new Set();
    const queue = [...modelos];
    while (queue.length && !res.providerUnavailable) {
      const m = queue.shift();
      used.add(m);
      const r = await callVerifier(ctx, wo, m, 'verifier', String(used.size), runDir, extra);
      res.cost = Number((res.cost + (r.out?.usage?.cost || 0)).toFixed(6));
      if (r.out?.providerUnavailable) {
        res.providerUnavailable = { ...r.out.providerUnavailable, model: m };
        warn(`verify: ${m} proveedor no disponible (${r.out.providerUnavailable.reason})`);
        break;
      }
      if (r.out?.exhausted && !r.verdict) {
        res.providerUnavailable = { model: m, reason: 'keys-exhausted', class: 'keys', attempts: 1, provider: null, message: 'keys de worker agotadas' };
        break;
      }
      const logFile = path.join(runDir, `verdict-${used.size}.json`);
      if (!r.verdict || noUsableVerdict(r.out)) {
        // Transporte/timeout/sin veredicto: reintento con otro modelo del pool si queda alguno (como el loop).
        const alt = pool.find((x) => !used.has(x));
        if (alt) { warn(`verify: ${m} sin veredicto utilizable → reintento con ${alt}`); queue.push(alt); continue; }
        if (noUsableVerdict(r.out)) {
          res.providerUnavailable = {
            model: m, reason: r.out?.timedOut ? 'timeout' : 'transport', class: 'no-veredicto', attempts: 1,
            provider: null, message: String(r.out?.errorMessage || r.out?.stderr || '').trim().slice(0, 200) || null,
          };
          break;
        }
        // Contestó pero sin JSON: sin veredicto no se aprueba (normalizeVerdict(undefined) → FAIL).
        res.verifiers.push({ model: m, verdict: 'FAIL', findings: [], log: logFile });
        continue;
      }
      const verdict = normalizeVerdict(r.verdict.verdict);
      const findings = Array.isArray(r.verdict.findings) ? r.verdict.findings : [];
      res.verifiers.push({ model: m, verdict, findings, log: logFile });
      log(`verify: ${m} → ${verdict}${findings.length ? ` (${findings.length} findings)` : ''}`);
    }

    // 4) guarda D2: antes/después del verifier; se revierte todo salvo `zz-qa-*`.
    // El índice se compara ANTES de cualquier reset/restore propio (que también lo tocan).
    const indexTouched = !sameIndex(indexBefore, await lsIndexEntries(wt));
    // Primero: refs. Si el verifier commiteó o cambió de rama, se reponen (sin tocar worktree ni índice) para que
    // sus cambios aparezcan en el diff y pasen por la restauración normal. Sólo se tocan la rama de antes y la
    // de después: los worktrees vinculados comparten refs con el repo y otras pueden moverse legítimamente.
    let commitViolation = null;
    const symAfter = String((await runProcess('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: wt })).out || '').trim();
    if (symAfter !== symBefore) {
      // Cambió de rama (o quedó detached): su rama nueva vuelve a donde estaba y HEAD apunta a la original.
      if (symAfter && refsBefore.has(symAfter)) await runProcess('git', ['update-ref', symAfter, refsBefore.get(symAfter)], { cwd: wt });
      if (symBefore) await runProcess('git', ['symbolic-ref', 'HEAD', symBefore], { cwd: wt });
      commitViolation = { path: '<HEAD>', action: `rama-restaurada (${symAfter || 'detached'} → ${symBefore || 'detached'})` };
    }
    const currentHead = String((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: wt })).out || '').trim();
    if (headBefore && currentHead && currentHead !== headBefore) {
      if (symBefore) await runProcess('git', ['update-ref', symBefore, headBefore], { cwd: wt });
      else await runProcess('git', ['update-ref', '--no-deref', 'HEAD', headBefore], { cwd: wt });
      commitViolation = commitViolation || { path: '<HEAD>', action: 'reset-soft-por-commit-del-verificador' };
    }

    // Ahora tomar snapshot después (con los cambios staged/modificados si había commits)
    const after = await qaSnapshot(wt);
    const diff = qaDiff(before, after, trackedBefore);
    res.kept = diff.kept;
    res.violations = await qaRestore(wt, before, baselineDir, diff.violations);
    if (commitViolation) res.violations.unshift(commitViolation);
    // El índice vuelve a ser el del autor (deshace `git add` del verifier y los `git reset` de qaRestore).
    restoreIndex(wt, indexBefore, await lsIndexEntries(wt));
    if (indexTouched) res.violations.push({ path: '<index>', action: 'indice-restaurado' });
    if (res.violations.length) {
      warn(`verify: VIOLACIÓN de permisos del verifier: ${res.violations.map((v) => `${v.path} (${v.action})`).join(', ')}`);
    }
    res.findings = compactFindings(res.verifiers);
    res.verdict = res.verifiers.length && res.verifiers.every((v) => v.verdict === 'PASS') ? 'PASS' : 'FAIL';
  }

  // El index del worktree ajeno vuelve a quedar como estaba (sólo los intent-to-add que creamos).
  await unstageIntent(wt, untrackedPre);

  // Exit codes D3: 2 violación > 3 provider-unavailable > 1 FAIL/gates rojos > 0 PASS.
  if (res.violations.length) res.exitCode = 2;
  else if (res.providerUnavailable || (res.gates.ok && !res.verifiers.length)) res.exitCode = 3;
  else res.exitCode = res.verdict === 'PASS' ? 0 : 1;

  writeJson(path.join(runDir, 'report.json'), res);
  fs.writeFileSync(path.join(runDir, 'report.md'), reportMd(res));
  log(`verify ${wo.id}: ${res.verdict} (exit ${res.exitCode}) → ${path.join(runDir, 'report.md')}`);
  if (args.json) console.log(JSON.stringify(res, null, 2));
  return res;
}
