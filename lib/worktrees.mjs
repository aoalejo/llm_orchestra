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

export function linkWorktreeDeps(wtDir, config) {
  for (const target of resolveLinkTargets(config)) {
    if (!exists(target)) continue;
    const linkPath = path.join(wtDir, path.relative(ROOT, target));
    if (exists(linkPath)) continue;
    ensureDir(path.dirname(linkPath));
    try { fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { warn(`no se pudo linkear ${path.relative(ROOT, target)}: ${e.message}`); }
  }
}

export async function prepareWorktree(config, task) {
  if (!config.worktrees?.enabled) return { dir: ROOT, branch: null, ephemeral: false };
  const dir = path.join(ROOT, config.worktrees.dir || '.orchestra/worktrees', task.id);
  const branch = `${config.integration?.branchPrefix || 'orchestra/'}${task.id}`;
  fs.rmSync(dir, { recursive: true, force: true });
  await runProcess('git', ['worktree', 'prune'], {});
  await runProcess('git', ['branch', '-D', branch], {});
  const r = await runProcess('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], {});
  if (r.code !== 0) { warn(`worktree no creado (${task.id}); uso ROOT. ${r.err.trim()}`); return { dir: ROOT, branch: null, ephemeral: false }; }
  if (config.worktrees?.linkNodeModules !== false) linkWorktreeDeps(dir, config);
  ACTIVE_WORKTREES.set(task.id, { dir, branch });
  return { dir, branch, ephemeral: true };
}
export async function removeWorktree(config, task) {
  if (!config.worktrees?.enabled) return;
  const dir = path.join(ROOT, config.worktrees.dir || '.orchestra/worktrees', task.id);
  await runProcess('git', ['worktree', 'remove', '--force', dir], {});
  // Limpieza: tras integrar, la rama de la tarea ya cumplió su función.
  const branch = `${config.integration?.branchPrefix || 'orchestra/'}${task.id}`;
  await runProcess('git', ['branch', '-D', branch], {});
  ACTIVE_WORKTREES.delete(task.id);
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
      const stateFile = path.join(RUNS, id, 'state.json');
      let approved = false;
      try { approved = exists(stateFile) && readJson(stateFile).status === 'approved'; } catch { /* estado corrupto: limpiar */ }
      if (approved) { warn(`  se conserva ${wt.dir} (${id} aprobada, pendiente de integración)`); continue; }
      await runProcess('git', ['worktree', 'remove', '--force', wt.dir], {});
      await runProcess('git', ['branch', '-D', wt.branch], {});
      log(`  eliminado worktree de ${id}`);
    }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(sig); });
}
