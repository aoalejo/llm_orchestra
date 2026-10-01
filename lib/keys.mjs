/** Pool de cuentas A/B y rotación. */
import process from 'node:process';
import { maskKey } from './util.mjs';
import { keysMode } from './pure.mjs';

export function makeKeyState() { return { workerKeyIdx: 0, exhausted: new Set() }; }

/**
 * Parsea una env var de keys: acepta un JSON array (`["k1","k2"]`) o una lista
 * separada por comas / saltos de línea / espacios / punto y coma. Una sola key
 * (sin delimitadores) también vale.
 */
export function parseKeyList(raw) {
  if (raw == null) return [];
  const t = String(raw).trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* cae a delimitadores */ }
  }
  const parts = /[\n,;\s]/.test(t) ? t.split(/[\n,;\s]+/) : [t];
  return parts.map((s) => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

/** Nombres de env vars que contienen keys de workers (admite string o array). */
export function workerKeyNames(config) {
  const w = config?.keys?.workers;
  if (typeof w === 'string') return [w];
  return Array.isArray(w) ? w.filter(Boolean) : [];
}

/**
 * Expande cada env var de workers en 1..N keys. `name` es un id estable
 * (`<envVar>#<idx>`) que se usa para la rotación y el ledger; nunca se loguea el valor.
 */
export function workerKeyEntries(config) {
  const out = [];
  if (keysMode(config) === 'pi-auth') return out;   // las credenciales las maneja pi: acá no se leen env vars de keys
  for (const envName of workerKeyNames(config)) {
    parseKeyList(process.env[envName]).forEach((value, index) => {
      out.push({ name: `${envName}#${index}`, envName, index, value });
    });
  }
  return out;
}

/**
 * Marcador de "credenciales de pi" (keys.mode = "pi-auth"): sin valor, así `--api-key` no se pasa y pi usa su
 * auth.json / variables de entorno. No es nulo para que el loop no lo confunda con "workers agotados".
 */
export const PI_AUTH_KEY = Object.freeze({ name: 'pi-auth', envName: null, index: 0, value: undefined, piAuth: true });

export function pickKey(config, ks, role) {
  if (keysMode(config) === 'pi-auth') return PI_AUTH_KEY;   // sin pool, sin rotación y nunca "agotada"
  const orchName = config.keys.orchestrator;
  if (role === 'orchestrator' || role === 'judge') {
    return { name: orchName, envName: orchName, index: 0, value: process.env[orchName] };
  }
  let pool = workerKeyEntries(config).filter((k) => !ks.exhausted.has(k.name));
  pool = orderPoolByQuota(pool, ks.quota, config.keys?.maxQuotaPct ?? 95);
  if (pool.length) {
    const pick = pool[ks.workerKeyIdx % pool.length];
    ks.workerKeyIdx = (ks.workerKeyIdx + 1) % pool.length;
    return pick;
  }
  // Fallback decidido por el orquestador: reutilizar la cuenta A para workers.
  if (ks.useOrchestratorKey) {
    return { name: orchName, envName: orchName, index: 0, value: process.env[orchName] };
  }
  return null;
}

/** Peor porcentaje de cuota (rolling/weekly/monthly); 0 si no se sabe. */
export function worstQuotaPct(usage) {
  if (!usage) return 0;
  return Math.max(usage.rolling?.percent ?? 0, usage.weekly?.percent ?? 0, usage.monthly?.percent ?? 0);
}

/**
 * Ordena el pool por cuota disponible (menor % primero) y descarta las que superan
 * `maxPct`. Si no hay datos (`quota` null) o todas están sobre el umbral, devuelve
 * el pool tal cual (el agotamiento en runtime sigue como red de seguridad).
 */
export function orderPoolByQuota(pool, quota, maxPct = 95) {
  if (!quota) return pool;
  const free = pool.filter((k) => worstQuotaPct(quota[k.value]) < maxPct);
  const usable = free.length ? free : pool;
  return [...usable].sort((a, b) => worstQuotaPct(quota[a.value]) - worstQuotaPct(quota[b.value]));
}

export function keysStatus(config) {
  if (keysMode(config) === 'pi-auth') {
    console.log(`modo de credenciales: pi-auth — las credenciales las maneja pi (~/.pi/agent/auth.json o variables de entorno del proveedor); sin pool ni rotación. Orchestra no lee ni muestra keys.`);
    return;
  }
  const orchName = config.keys.orchestrator;
  console.log(`${'orchestrator'.padEnd(13)} ${orchName.padEnd(30)} ${maskKey(process.env[orchName])}`);
  const entries = workerKeyEntries(config);
  const names = workerKeyNames(config);
  if (!entries.length) {
    console.log(`${'worker'.padEnd(13)} ${(names.join(', ') || '(sin configurar)').padEnd(30)} ${maskKey('')}`);
    return;
  }
  for (const k of entries) console.log(`${'worker'.padEnd(13)} ${k.name.padEnd(30)} ${maskKey(k.value)}`);
}
