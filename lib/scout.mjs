/**
 * Scout: recon barato del codebase.
 *
 * Providers:
 *   - `llm`: un modelo worker (headless pi) sintetiza un mapa comprimido.
 *   - `socraticode`: consulta un server MCP externo (SocratiCode) y usa los
 *     chunks como contexto (o directamente como mapa si `synthesize:false`).
 *   - `auto` (default): usa socraticode si está disponible e indexado; si no, LLM.
 *
 * Cache: `.orchestra/runs/scout/cache/<key>.json`, keyed por git HEAD + provider
 * + query + scope + projectPath. Evita repetir recon (0 tokens) mientras no
 * cambie el HEAD.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, RUNS } from './paths.mjs';
import { ensureDir, exists, readJson, writeJson, now } from './util.mjs';
import { withMcp, mcpCallTool } from './mcp.mjs';
import { runProcess } from './runner.mjs';

const SCOUT_DIR = () => path.join(RUNS, 'scout');
const CACHE_DIR = () => path.join(SCOUT_DIR(), 'cache');

export function scoutCacheKey({ head, provider, query, scope, projectPath }) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ head, provider, query, scope: scope || [], projectPath }))
    .digest('hex').slice(0, 16);
}

export async function gitHead(cwd = ROOT) {
  const r = await runProcess('git', ['rev-parse', 'HEAD'], { cwd });
  return (r.out || '').trim() || 'no-git';
}

/** Opciones de SocratiCode desde config, con defaults que matchean su compose. */
export function socraticodeOptions(config) {
  const s = config?.scout?.socraticode || {};
  return {
    command: s.command || 'npx',
    args: Array.isArray(s.args) && s.args.length ? s.args : ['-y', '--prefer-online', 'socraticode@latest'],
    env: s.env || {},
    projectPath: (s.projectPath || ROOT).replace(/\\/g, '/'),
    limit: s.limit ?? 8,
    minScore: s.minScore,
    autoIndex: !!s.autoIndex,
    synthesize: s.synthesize !== false,
    timeoutMs: s.timeoutMs ?? 120000,
  };
}

/** Arma el prompt del scout LLM, inyectando el contexto externo si existe. */
export function buildScoutPrompt({ query, scope = [], task, external }) {
  const parts = [query];
  if (scope.length) parts.push(`\nSCOPE (priorizá): ${scope.join(', ')}`);
  if (task?.acceptance?.length) parts.push(`\nACCEPTANCE:\n- ${task.acceptance.join('\n- ')}`);
  if (external?.ok && external.chunks) {
    parts.push(`\nCONTEXTO YA RECUPERADO (búsqueda semántica; usalo como base y sintetizá el mapa, no inventes rutas):\n${external.chunks}`);
  }
  return parts.join('\n');
}

/**
 * Consulta SocratiCode. Nunca lanza: devuelve `{ ok, ... }` o
 * `{ ok:false, reason, detail }` para que el caller decida el fallback.
 */
export async function socraticodeGather(config, query) {
  const o = socraticodeOptions(config);
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  try {
    return await withMcp(
      { command: o.command, args: o.args, env: o.env, cwd: ROOT, timeoutMs: o.timeoutMs, initTimeoutMs: o.timeoutMs },
      async (client) => {
        // Warm-up: health conecta Qdrant/Ollama (sin esto el primer search puede dar "fetch failed").
        const health = await mcpCallTool(client, 'codebase_health', {}, o.timeoutMs);
        const status = await mcpCallTool(client, 'codebase_status', { projectPath: o.projectPath }, o.timeoutMs);
        const indexed = /Indexed chunks:\s*[1-9]\d*/i.test(status.text) && !/No index found/i.test(status.text);
        if (!indexed) {
          if (o.autoIndex) {
            await mcpCallTool(client, 'codebase_index', { projectPath: o.projectPath }, o.timeoutMs);
            return { ok: false, reason: 'indexing-started', detail: status.text.slice(0, 200), ms: ms() };
          }
          return { ok: false, reason: 'not-indexed', detail: status.text.slice(0, 200), ms: ms() };
        }
        const searchArgs = { query, projectPath: o.projectPath, limit: o.limit };
        if (o.minScore != null) searchArgs.minScore = o.minScore;
        const search = await mcpCallTool(client, 'codebase_search', searchArgs, o.timeoutMs);
        if (search.isError || /^fetch failed/i.test(search.text)) {
          return { ok: false, reason: 'search-error', detail: search.text.slice(0, 200), ms: ms() };
        }
        return { ok: true, source: 'socraticode', chunks: search.text, health: health.text.slice(0, 300), ms: ms() };
      },
    );
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: String(e?.message || e).slice(0, 200), ms: ms() };
  }
}

export function readScoutCache(key, ttlMinutes) {
  if (!ttlMinutes || ttlMinutes <= 0) return null;
  const f = path.join(CACHE_DIR(), `${key}.json`);
  if (!exists(f)) return null;
  try {
    const c = readJson(f);
    if (Date.now() - new Date(c.ts).getTime() > ttlMinutes * 60000) return null;
    return c;
  } catch { return null; }
}

export function writeScoutCache(key, data) {
  ensureDir(CACHE_DIR());
  try { writeJson(path.join(CACHE_DIR(), `${key}.json`), { ts: now(), ...data }); } catch { /* noop */ }
}

export function scoutPaths(scope = []) {
  return { dir: SCOUT_DIR(), cacheDir: CACHE_DIR(), scope };
}

/**
 * ¿La salida del scout parece un mapa (T-10)? Al menos una línea `path:line` o
 * `path — desc`. Rechaza respuestas meta/charlando sin rutas.
 */
export function looksLikeMap(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\b(i need to|i'll|i will|let me|i should|next, i|here's what)\b/i.test(t) && !/:\d+/.test(t)) return false;
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const mapy = lines.filter((l) => /[\w.@/\\-]+\.\w{1,8}:\d+/.test(l) || /[\w.@/\\-]+\.\w{1,8}\s+[—–-]\s+/.test(l));
  return mapy.length >= 1;
}
