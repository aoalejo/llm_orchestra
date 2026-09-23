/**
 * Cuota de las cuentas: `GET {baseUrl}/usage` (rolling / weekly / monthly, %).
 *
 * Descubierto en vivo (2026-09): opencode-go expone el porcentaje consumido por
 * ventana. Sirve para decidir si conviene cerrar con la cuenta A antes de que B
 * se agote, sin adivinar el saldo.
 */
import process from 'node:process';
import { providerBaseUrl } from './models.mjs';
import { workerKeyEntries } from './keys.mjs';

const cache = new Map(); // keyValue -> { ts, data }

/** Normaliza la respuesta de /usage. */
export function parseUsage(json) {
  const u = json?.usage || json || {};
  const win = (w) => (w && typeof w.percent === 'number' ? { percent: w.percent, resetsAt: w.resetsAt || null, status: w.status || null } : null);
  return { rolling: win(u.rolling), weekly: win(u.weekly), monthly: win(u.monthly) };
}

const worst = (u) => Math.max(u?.rolling?.percent ?? 0, u?.weekly?.percent ?? 0, u?.monthly?.percent ?? 0);
export function quotaStatus(usage, warnPct = 80) { return usage ? (worst(usage) >= warnPct ? 'low' : 'ok') : 'unknown'; }

export async function fetchUsage(config, keyValue, { timeoutMs = 8000, noCache = false } = {}) {
  if (!keyValue) return null;
  const hit = cache.get(keyValue);
  if (!noCache && hit && Date.now() - hit.ts < 60000) return hit.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${providerBaseUrl(config)}/usage`, { headers: { Authorization: `Bearer ${keyValue}` }, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = parseUsage(await res.json());
    cache.set(keyValue, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Uso por cuenta: orquestador (A) + workers (B), con nombre enmascarado. */
export async function usageSnapshot(config, { includeWorkers = true, noCache = false } = {}) {
  const out = [];
  const orchName = config.keys.orchestrator;
  const orchVal = process.env[orchName];
  if (orchVal) out.push({ role: 'orchestrator', name: orchName, usage: await fetchUsage(config, orchVal, { noCache }) });
  if (includeWorkers) {
    for (const k of workerKeyEntries(config)) out.push({ role: 'worker', name: k.name, usage: await fetchUsage(config, k.value, { noCache }) });
  }
  return out;
}
