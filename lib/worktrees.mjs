/** Worktrees de git, enlace de dependencias y limpieza por señales. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT, RUNS } from './paths.mjs';
import { ensureDir, exists, readJson, safeReaddir } from './util.mjs';
import { log, warn } from './log.mjs';
import { runProcess } from './runner.mjs';

// Worktrees creados en esta corrida, para limpiarlos si llega SIGINT/SIGTERM.
export const ACTIVE_WORKTREES = new Map();

// Patrones de dependencias a linkear en el worktree (relativos a ROOT, `*` = un nivel).
// Default genérico; se sobreescribe con `worktrees.link` en config.json.
export function resolveLinkTargets(config) {
  const spec = config?.worktrees?.link;
  const patterns = Array.isArray(spec) && spec.length ? spec : ['node_modules', 'packages/*/node_modules', 'apps/*/node_modules'];
  const out = [];
  for (const raw of patterns) {
    const norm = String(raw).replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!norm) continue;
    const parts = norm.split('/');
    const star = parts.indexOf('*');
    if (star === -1) { out.push(path.join(ROOT, ...parts)); continue; }
    const base = path.join(ROOT, ...parts.slice(0, star));
    const rest = parts.slice(star + 1);
    for (const e of safeReaddir(base)) {
      if (!e.isDirectory()) continue;
      out.push(path.join(base, e.name, ...rest));
    }
  }
  return out;
}

/** Rutas (dentro del worktree) donde irían los enlaces de dependencias. */
export function linkPathsIn(wtDir, config) {
  return resolveLinkTargets(config).map((t) => path.join(wtDir, path.relative(ROOT, t)));
}

export function linkWorktreeDeps(wtDir, config) {
  const linked = [];
  for (const target of resolveLinkTargets(config)) {
    if (!exists(target)) continue;
    const linkPath = path.join(wtDir, path.relative(ROOT, target));
    if (exists(linkPath)) continue;
    ensureDir(path.dirname(linkPath));
    try {
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(linkPath);
    } catch (e) { warn(`no se pudo linkear ${path.relative(ROOT, target)}: ${e.message}`); }
  }
  return linked;
}

/**
 * Quita los junctions/symlinks de dependencias SIN tocar su destino.
 *
 * Crítico en Windows: `git worktree remove --force` (y cualquier borrado
 * recursivo) puede atravesar el junction y destruir el node_modules real del
 * proyecto. Se observó en producción: borró apps/backend/node_modules/.bin.
 */
export function unlinkWorktreeDeps(wtDir, links) {
  const candidates = Array.isArray(links) && links.length ? links : linkPathsIn(wtDir, {});
  for (const linkPath of candidates) {
    try {
      if (!fs.lstatSync(linkPath).isSymbolicLink()) continue;
      try { fs.rmdirSync(linkPath); }
      catch { fs.rmSync(linkPath, { recursive: false, force: true }); }
    } catch { /* no existe: nada que hacer */ }
  }
}

/**
 * Si el borrado de un worktree falló por un handle ajeno (EBUSY/EPERM/ENOTEMPTY) y el directorio sigue
 * siendo un worktree (tiene `.git`), devuelve la nota para reusarlo; si quedó a medias, null.
 */
export function describeBusyReuse(dir, err) {
  const busy = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(err?.code);
  if (!busy || !exists(path.join(dir, '.git'))) return null;
  return {
    kind: 'worktree-reusado-por-ocupado',
    error: err.code,
    dir,
    message: `el worktree ${dir} no se pudo borrar (${err.code}: un proceso lo tiene tomado) → se REUSA tal como está; el gate baseline puede venir sucio`,
  };
}

export async function prepareWorktree(config, task, { reuse = false } = {}) {
  if (!config.worktrees?.enabled) return { dir: ROOT, branch: null, ephemeral: false };
  const dir = path.join(ROOT, config.worktrees.dir || '.orchestra/worktrees', task.id);
  const branch = `${config.integration?.branchPrefix || 'orchestra/'}${task.id}`;
  // Resume/approve: reusar el worktree existente para NO perder los cambios del autor.
  if (reuse && exists(dir)) {
    const active = ACTIVE_WORKTREES.get(task.id);
    if (active) return { dir, branch, ephemeral: true };
    const links = linkPathsIn(dir, config).filter((p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } });
    ACTIVE_WORKTREES.set(task.id, { dir, branch, links });
    return { dir, branch, ephemeral: true };
  }
  // Si quedó un worktree anterior, deslinkear sus junctions ANTES de borrar.
  unlinkWorktreeDeps(dir, linkPathsIn(dir, config));
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) {
    // Un proceso del run anterior (server de prueba, sonda, hijo RPC) tiene el cwd tomado: EBUSY/EPERM.
    // Antes esto tiraba al driver entero (ticket 0068 de pi-web). Un worktree sucio es información, no un
    // error fatal: si sigue siendo un worktree válido se REUSA y queda anotado en el log y en el state.json.
    const note = describeBusyReuse(dir, e);
    if (!note) throw new Error(`no se pudo borrar el worktree de ${task.id} (${e.code || e.message}) y quedó a medias (sin .git): matá a los procesos que tienen ${dir} como cwd (AGENTS.md gotcha 17) y reintentá`);
    warn(note.message);
    const links = linkPathsIn(dir, config).filter((p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } });
    ACTIVE_WORKTREES.set(task.id, { dir, branch, links });
    return { dir, branch, ephemeral: true, note };
  }
  await runProcess('git', ['worktree', 'prune'], {});
  await runProcess('git', ['branch', '-D', branch], {});
  const r = await runProcess('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], {});
  if (r.code !== 0) { warn(`worktree no creado (${task.id}); uso ROOT. ${r.err.trim()}`); return { dir: ROOT, branch: null, ephemeral: false }; }
  const links = config.worktrees?.linkNodeModules !== false ? linkWorktreeDeps(dir, config) : [];
  ACTIVE_WORKTREES.set(task.id, { dir, branch, links });
  return { dir, branch, ephemeral: true };
}
export async function removeWorktree(config, task) {
  if (!config.worktrees?.enabled) return;
  const dir = path.join(ROOT, config.worktrees.dir || '.orchestra/worktrees', task.id);
  // Primero los junctions: si git borra recursivamente a través de ellos,
  // destruye el node_modules real del proyecto.
  unlinkWorktreeDeps(dir, ACTIVE_WORKTREES.get(task.id)?.links ?? linkPathsIn(dir, config));
  await runProcess('git', ['worktree', 'remove', '--force', dir], {});
  // Limpieza: tras integrar, la rama de la tarea ya cumplió su función.
  const branch = `${config.integration?.branchPrefix || 'orchestra/'}${task.id}`;
  await runProcess('git', ['branch', '-D', branch], {});
  ACTIVE_WORKTREES.delete(task.id);
}

const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * ¿Hay una corrida en vuelo para esta tarea? Devuelve el motivo o null. Dos señales, las dos con el pid VIVO
 * (un marcador viejo de un driver muerto no cuenta): un `batch-*.json` en `running` que lista la orden, o el
 * `heartbeat.json` de la tarea con un latido reciente. `--clean` la leía como huérfana y le borraba el
 * worktree Y la rama a un run recién despachado (ticket 0077 de pi-web).
 */
export function inFlightReason(id, { runs = RUNS, alive = pidAlive, nowMs = Date.now(), staleMs = 3 * 60 * 1000 } = {}) {
  for (const e of safeReaddir(runs)) {
    if (!e.isFile() || !/^batch-.*\.json$/.test(e.name)) continue;
    try {
      const b = readJson(path.join(runs, e.name));
      if (b.status === 'running' && Array.isArray(b.orders) && b.orders.includes(id) && alive(b.pid)) return `lote ${b.runId || e.name} en vuelo (pid ${b.pid})`;
    } catch { /* marcador ilegible: no es señal */ }
  }
  try {
    const hb = readJson(path.join(runs, id, 'heartbeat.json'));
    const age = nowMs - Date.parse(hb.ts);
    if (alive(hb.pid) && age < staleMs) return `latido de hace ${Math.round(age / 1000)}s (pid ${hb.pid})`;
  } catch { /* sin latido */ }
  return null;
}

function isApproved(id) {
  const stateFile = path.join(RUNS, id, 'state.json');
  try { return exists(stateFile) && readJson(stateFile).status === 'approved'; } catch { return false; }
}

/**
 * Limpieza segura de worktrees y ramas huérfanas. Deslinkea los junctions ANTES
 * de borrar (para no atravesar el node_modules real). Conserva los de tareas
 * `approved` (trabajo válido pendiente de integrar) salvo `force`.
 */
export async function cleanWorktrees(config, { force = false } = {}) {
  const base = path.join(ROOT, config.worktrees?.dir || '.orchestra/worktrees');
  const dirs = safeReaddir(base).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name));
  const kept = []; let cleaned = 0;
  const prefix = config.integration?.branchPrefix || 'orchestra/';
  const skipped = new Set();
  for (const dir of dirs) {
    const id = path.basename(dir);
    const flying = inFlightReason(id);
    if (flying) { skipped.add(id); warn(`  salteo ${id}: corrida en vuelo (${flying}); ni el worktree ni la rama se tocan, ni con --force`); continue; }
    const hasBranch = (await runProcess('git', ['branch', '--list', `${prefix}${id}`, '--format=%(refname:short)'], {})).out.trim();
    if (!hasBranch) warn(`  inconsistencia en ${id}: el worktree existe pero la rama ${prefix}${id} no (¿un clean anterior?); se limpia igual`);
    if (isApproved(id) && !force) { kept.push(id); continue; }
    unlinkWorktreeDeps(dir, linkPathsIn(dir, config));
    const r = await runProcess('git', ['worktree', 'remove', '--force', dir], {});
    if (r.code !== 0) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } }
    cleaned++;
    log(`  worktree limpiado: ${id}`);
  }
  await runProcess('git', ['worktree', 'prune'], {});
  const br = await runProcess('git', ['branch', '--list', `${prefix}*`, '--format=%(refname:short)'], {});
  for (const name of br.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const id = name.slice(prefix.length);
    if (skipped.has(id) || inFlightReason(id)) { warn(`  salteo ${name}: corrida en vuelo`); continue; }
    if (isApproved(id) && !force) { kept.push(name); continue; }
    await runProcess('git', ['branch', '-D', name], {});
    log(`  rama eliminada: ${name}`);
  }
  if (kept.length) warn(`conservados (aprobados, pendientes de integrar): ${kept.join(', ')} — usá --force para borrarlos`);
  log(`clean listo: ${cleaned} worktree(s) eliminados`);
}

/**
 * Ctrl+C / kill: elimina los worktrees que quedaron a medio hacer.
 * Conserva los de tareas ya aprobadas (hay trabajo válido pendiente de integrar).
 */
export function installSignalHandlers() {
  let handling = false;
  const cleanup = async (sig) => {
    if (handling) return;
    handling = true;
    const code = sig === 'SIGINT' ? 130 : 143;
    if (!ACTIVE_WORKTREES.size) process.exit(code);
    warn(`${sig}: limpiando ${ACTIVE_WORKTREES.size} worktree(s) en vuelo`);
    for (const [id, wt] of ACTIVE_WORKTREES) {
      if (isApproved(id)) { warn(`  se conserva ${wt.dir} (${id} aprobada, pendiente de integración)`); continue; }
      unlinkWorktreeDeps(wt.dir, wt.links || []);
      await runProcess('git', ['worktree', 'remove', '--force', wt.dir], {});
      await runProcess('git', ['branch', '-D', wt.branch], {});
      log(`  eliminado worktree de ${id}`);
    }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(sig); });
}
