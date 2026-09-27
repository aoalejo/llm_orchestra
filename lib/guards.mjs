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

/**
 * Lo que un subagente (y un `pi` despertado por un wake) NO puede hacer: disparar más subagentes ni
 * agendarse wakes. Es la política que se activa con `guards.noSelfOrchestration` en el proyecto o con
 * `ORCHESTRA_NO_SELF=1` en el entorno (así lo marca pi-web cuando corre el `pi -p` de un wake).
 *
 * Ojo: son regexes sobre el comando, así que también rebotan lecturas inocentes (un `grep api/wake`),
 * que es el precio de no tener una barrera real. `orchestra.mjs --self-test` SÍ pasa (no gasta ni dispara
 * nada) porque no está en la lista de verbos. Desde el 0034 las lecturas de `api/sessions` por curl pasan
 * (ver `allowReadOnlyApi`) y las tools de pi están cubiertas por `NO_SELF_TOOLS`.
 */
export const NO_SELF_COMMANDS = [
  'orchestra\\.mjs\\s+(dispatch|approve|reject|--all|--task|--plan)\\b',
  'orchestra\\.mjs\\s*($|&&|;|\\|)',
  // Disparar un agente = crear un job, una sesión, o agendarse un wake: esos endpoints no se tocan.
  // Borrar un wake PUNTUAL (`api/wake/<id>`) sí se permite: es limpieza, y sin esto un monitor que
  // despierta al agente no puede apagarse solo (pasó 2026-09-26: se quedó disparando cada 30 min).
  'api/(jobs|sessions)',
  'api/wake(?:$|[?"\\s]|/tick)',
];

/**
 * D (ticket 0034): las tools de pi no pasan por `bash`, así que la restricción era letra muerta para
 * un agente con herramientas (`orchestra_dispatch` despachaba igual desde un wake). El hook las mira
 * por nombre. `orchestra_status`/`report`/`dashboard`/`usage`/`models` son lectura y siguen permitidas;
 * `scout` también (gasta un modelo pero no escribe ni dispara el loop).
 */
export const NO_SELF_TOOLS = ['orchestra_dispatch', 'orchestra_approve', 'orchestra_reject'];

/**
 * C (ticket 0034): mirar el estado NO es disparar un agente. Se permite el `curl` de LECTURA sobre
 * `api/sessions` (un wake que no sabe por qué no se entregó su mensaje no puede ni diagnosticarlo) y
 * sigue bloqueado cualquier curl con método o body de escritura (`-X POST`, `-d`, `-F`, `-T`).
 */
const READ_ONLY_API = [/\bcurl\b[^|;&>]*\/api\/sessions(?:[\/?"'\s]|$)/];
const WRITE_HTTP = /(?:-X|--request)\s*["']?(?:POST|PUT|PATCH|DELETE)|(?:^|\s)(?:-d|--data[\w-]*|-F|--form|-T|--upload-file)\b/i;
export function allowReadOnlyApi(cmd) {
  const c = String(cmd || '');
  return READ_ONLY_API.some((re) => re.test(c)) && !WRITE_HTTP.test(c);
}

/** Config efectiva de guards (o null si están deshabilitados). */
export function exportGuards(config) {
  const g = config?.guards || {};
  if (g.enabled === false) return null;
  return {
    denyRead: Array.isArray(g.denyRead) ? g.denyRead : DEFAULT_DENY_READ,
    denyCommands: Array.isArray(g.denyCommands) ? g.denyCommands : DEFAULT_DENY_COMMANDS,
    logCommands: g.logCommands !== false,
    blockConfidential: !!g.blockConfidential,
    noSelfOrchestration: !!g.noSelfOrchestration,   // subagentes/wakes no disparan subagentes ni wakes
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
