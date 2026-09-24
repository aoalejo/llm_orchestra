/**
 * Guardarraíles para subagentes (T-05 egress / T-12 contención).
 *
 * El driver exporta estos valores por env (ORCHESTRA_GUARDS) y la extensión de
 * pi los aplica en el hook tool_call, que corre también en los pi headless de
 * los workers. Acá viven las funciones puras (globs, deny, lint de acceptance).
 */
import process from 'node:process';

export const DEFAULT_DENY_READ = [
  '.orchestra/.env', '.orchestra/.env.*', '.orchestra/ledger.jsonl',
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12',
  '**/id_rsa*', '**/id_ed25519*', '**/.ssh/**', '**/.aws/**', '**/.gnupg/**',
];

export const DEFAULT_DENY_COMMANDS = [
  'Stop-Process', 'taskkill',
  'docker\\s+compose\\s+(up|down|restart|stop|kill)',
  'docker\\s+(restart|stop|kill|rm)',
  'systemctl\\s+(restart|stop|disable)',
  'service\\s+\\S+\\s+(restart|stop)',
  '\\bpkill\\b', '\\bkillall\\b', 'run_proto',
  'shutdown', '\\breboot\\b',
];

/** Config efectiva de guards (o null si están deshabilitados). */
export function exportGuards(config) {
  const g = config?.guards || {};
  if (g.enabled === false) return null;
  return {
    denyRead: Array.isArray(g.denyRead) ? g.denyRead : DEFAULT_DENY_READ,
    denyCommands: Array.isArray(g.denyCommands) ? g.denyCommands : DEFAULT_DENY_COMMANDS,
    logCommands: g.logCommands !== false,
    blockConfidential: !!g.blockConfidential,
    role: process.env.ORCHESTRA_ROLE || null,
  };
}

export function globToRegExp(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = esc.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + re + '$', 'i');
}

/** Match de un path contra un glob estilo git (doble asterisco, asterisco simple y prefijo). */
export function matchGlob(pathStr, glob) {
  const p = String(pathStr || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (globToRegExp(g).test(p)) return true;
  if (g.startsWith('**/') && globToRegExp(g.slice(3)).test(p)) return true;
  return false;
}

export function denyReadHit(pathStr, patterns) {
  const base = String(pathStr || '').replace(/\\/g, '/').split('/').pop() || '';
  if (/^\.env\.(example|sample|template|dist)$/i.test(base)) return false;   // plantillas de env: no son secretos
  return (patterns || []).some((g) => matchGlob(pathStr, g));
}

export function denyCommandHit(cmd, patterns) {
  return (patterns || []).some((re) => { try { return new RegExp(re, 'i').test(cmd); } catch { return false; } });
}

/** Extrae paths con barra y extensión de un texto (acceptance/goal). */
export function extractPaths(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/([\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8})/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Lint de acceptance (T-08): detecta rutas citadas que son protegidas, ignoradas
 * por git o inexistentes en el worktree. isIgnored y exists se inyectan.
 */
export function lintAcceptance({ task = {}, protectedPaths = [], isIgnored = () => false, exists = () => true } = {}) {
  const texts = [...(task.acceptance || []), task.goal || '', task.title || ''];
  const paths = [...new Set(texts.flatMap(extractPaths))];
  const warnings = [];
  for (const p of paths) {
    const protectedHit = (protectedPaths || []).some((pp) => matchGlob(p, pp) || matchGlob(pp, p) || String(pp).replace(/\\/g, '/').startsWith(p));
    if (protectedHit) warnings.push(p + ': toca una ruta protegida');
    else if (isIgnored(p)) warnings.push(p + ': ruta ignorada por git (dato local/confidencial?)');
    else if (!exists(p)) warnings.push(p + ': no existe en el proyecto (¿fixture faltante?)');
  }
  return { paths, warnings };
}
