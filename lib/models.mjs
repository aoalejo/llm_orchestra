/**
 * Catálogo de modelos de opencode-go + refresh de rankings.
 *
 * - `fetchLiveModels`: lista viva del endpoint OpenAI-compatible
 *   (`GET {baseUrl}/models`), con la key del orquestador/worker o la de
 *   `~/.pi/agent/auth.json`.
 * - `loadCostCatalog`: costos/contexto desde el cache de pi
 *   (`~/.pi/agent/models-store.json`), que es la fuente autoritativa local.
 * - `mergeCatalog`: une ambos y marca los modelos que sólo aparecen en el
 *   endpoint (sin costo conocido todavía).
 * - `refreshRankings`: hace el refresh completo (catálogo + arena) y devuelve
 *   el ranking listo para aplicar.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchWebDevLeaderboard, DEFAULT_ARENA_URL } from './leaderboard.mjs';
import { rankModels } from './rank.mjs';

export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';

export function providerBaseUrl(config) {
  return process.env.ORCHESTRA_BASE_URL || config?.providerBaseUrl || DEFAULT_BASE_URL;
}

/** Key del provider: env de A, env de B, o `auth.json` de pi. Nunca se loguea. */
export function resolveProviderKey(config) {
  const names = [config?.keys?.orchestrator, ...(config?.keys?.workers || [])].filter(Boolean);
  for (const n of names) if (process.env[n]) return process.env[n];
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8'));
    return auth?.[config.provider]?.key || null;
  } catch {
    return null;
  }
}

export async function fetchLiveModels({ baseUrl = DEFAULT_BASE_URL, apiKey } = {}) {
  const headers = { 'User-Agent': 'orchestra-model-catalog' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) throw new Error(`GET ${baseUrl}/models → HTTP ${res.status}`);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return data.map((m) => m.id).filter(Boolean);
}

export function loadCostCatalog(provider, storePath) {
  const p = storePath || process.env.ORCHESTRA_MODELS_STORE || path.join(os.homedir(), '.pi', 'agent', 'models-store.json');
  try {
    const store = JSON.parse(fs.readFileSync(p, 'utf8'));
    const models = store?.[provider]?.models;
    if (!Array.isArray(models)) return [];
    return models.map((m) => ({
      id: m.id,
      cost: m.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : null,
      contextWindow: m.contextWindow ?? null,
      reasoning: !!m.reasoning,
    }));
  } catch {
    return [];
  }
}

/** Une el listado vivo con los costos cacheados. `liveOnly` = sin costo conocido. */
export function mergeCatalog(liveIds = [], cached = []) {
  const byId = new Map(cached.map((m) => [m.id, { ...m, live: false }]));
  for (const id of liveIds) byId.set(id, { ...(byId.get(id) || { id, cost: null, contextWindow: null, reasoning: false }), live: true });
  return [...byId.values()];
}

export function rankingsStale(generatedAt, maxAgeDays = 7) {
  if (!generatedAt) return true;
  return Date.now() - new Date(generatedAt).getTime() > maxAgeDays * 864e5;
}

/**
 * Refresh completo: lista viva + costos + leaderboard → ranking.
 * Si no hay key, igual usa el catálogo cacheado (sólo se pierde el diff de altas).
 */
export async function refreshRankings(config, { arenaUrl } = {}) {
  const baseUrl = providerBaseUrl(config);
  const apiKey = resolveProviderKey(config);
  const cached = loadCostCatalog(config.provider);
  let live = [];
  let liveError = null;
  try {
    live = await fetchLiveModels({ baseUrl, apiKey });
  } catch (e) {
    liveError = e.message;
  }
  const catalog = mergeCatalog(live, cached);
  const url = arenaUrl || config?.models?.arenaUrl || DEFAULT_ARENA_URL;
  const rows = await fetchWebDevLeaderboard(url);
  if (!rows.length) throw new Error('leaderboard vacío (¿cambió el markup de arena.ai?)');
  const ranking = rankModels(catalog, rows, config?.models || {});
  return {
    provider: config.provider,
    baseUrl,
    liveCount: live.length,
    liveError,
    liveOnly: catalog.filter((m) => m.live && !m.cost).map((m) => m.id),
    staleOnly: cached.map((m) => m.id).filter((id) => live.length && !live.includes(id)),
    ...ranking,
  };
}
