/**
 * Ranking de modelos para la rotación del Lean Orchestrator.
 *
 * Cruza el catálogo real de opencode-go (id + costo por millón) contra el score
 * WebDev/code de arena.ai y arma pools:
 *   - `author` / `verifier`: los mejores modelos baratos (rotación).
 *   - `fallback`: los siguientes baratos, cuando se agota la cuota.
 *   - `escalationAuthor` / `escalationVerifier`: los mejores por score.
 *
 * Inspirado en `aoalejo/opencode_mcp` (src/rank.js), pero más simple: acá no
 * hay "tiers" low/mid/high/max, sino pools de rol para el loop Ralph.
 *
 * Tres fuentes de score, en orden de confianza (`source`):
 *   1. `arena`    — match directo del id contra un slug del leaderboard.
 *   2. `alias`    — el id figura en arena bajo otro slug (`models.aliases`).
 *      Ej: `qwen3.8-flash` se publica como `qwen3.8-flash-next`.
 *   3. `override` — score fijado a mano para un SKU nuevo que arena aún no
 *      rankea (`models.scoreOverrides`). Ej: `mimo-v2.6-flash`.
 *   4. `family`   — último recurso: se hereda el mejor score de la familia
 *      (mismo prefijo alfabético) con un descuento, marcado `inferred`.
 */
import { matchModel } from './leaderboard.mjs';

const costIn = (m) => (typeof m.cost?.input === 'number' ? m.cost.input : Infinity);
const scoreOf = (a) => (typeof a.score === 'number' ? a.score : -1);

// "Near-tie": si dos scores están dentro de este %, gana el más barato.
// Un 0.5% de ventaja no justifica pagar 5x más (misma regla que opencode_mcp).
const DEFAULT_SCORE_TOLERANCE_PCT = 0.01;
// Descuento aplicado al score heredado de la familia (es una estimación, no un dato).
const FAMILY_DISCOUNT = 0.95;

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// Sufijos del **id de opencode-go** que no cambian el modelo (deployment/build),
// y que por lo tanto se pueden quitar para matchear contra arena.
// Ej: `muse-spark-1.2-contributor` figura en arena como `muse-spark-1.2 (xHigh)`.
const ID_SUFFIXES = ['contributor', 'exp', 'experimental', 'instruct', 'chat', 'latest', 'snapshot', 'beta', 'preview'];

/** [id, id-sin-último-sufijo, ...] mientras el sufijo quitado sea no semántico. */
export function idVariants(id) {
  const out = [String(id)];
  let cur = String(id);
  for (;;) {
    const parts = cur.split('-');
    if (parts.length < 2) break;
    if (!ID_SUFFIXES.includes(parts[parts.length - 1].toLowerCase())) break;
    parts.pop();
    cur = parts.join('-');
    out.push(cur);
  }
  return out;
}

/** Familia de un modelo: primer tramo alfabético (`mimo-v2.6-flash` → `mimo`). */
export function modelFamily(id) {
  const m = String(id).toLowerCase().match(/^([a-z]+)/);
  return m ? m[1] : null;
}

/** Busca el mejor match en arena probando el id, sus aliases y sus variantes sin sufijo. */
export function bestArenaMatch(id, rows, aliases) {
  const seeds = [
    { slug: String(id), origin: 'arena' },
    ...asArray(aliases?.[id]).map((a) => ({ slug: String(a), origin: 'alias' })),
  ];
  const candidates = [];
  const seen = new Set();
  for (const s of seeds) {
    idVariants(s.slug).forEach((v, i) => {
      if (seen.has(v)) return;
      seen.add(v);
      candidates.push({ slug: v, origin: i === 0 ? s.origin : 'suffix' });
    });
  }
  let best = null;
  for (const c of candidates) {
    const m = matchModel(c.slug, rows || []);
    if (m && (!best || m.score > best.score)) {
      best = { ...m, source: c.origin, viaSlug: m.slug, matchedAs: c.slug };
    }
  }
  return best;
}

/**
 * @param {Array} catalog  [{id, cost:{input,output}, contextWindow}]
 * @param {Array} rows     filas del leaderboard (leaderboard.mjs)
 * @param {object} opts
 *   workerMaxInputCost  costo máx USD/M input para entrar a la rotación (default 0.5)
 *   workersPerRole      cupos por rol autor/verifier (default 3)
 *   fallbackCount       modelos de fallback (default 3)
 *   minContextWindow    ignora modelos con contexto menor a esto (default 0)
 *   scoreTolerancePct   empate técnico → gana el más barato (default 0.01)
 *   aliases             {modelId: [slugDeArena, ...]}
 *   scoreOverrides      {modelId: score | {score, note}}
 *   familyInference     heredar score de la familia si no hay dato (default true)
 */
export function rankModels(catalog, rows, opts = {}) {
  const workerMaxInputCost = opts.workerMaxInputCost ?? 0.5;
  const workersPerRole = opts.workersPerRole ?? 3;
  const fallbackCount = opts.fallbackCount ?? 3;
  const minContextWindow = opts.minContextWindow ?? 0;
  const tolerance = opts.scoreTolerancePct ?? DEFAULT_SCORE_TOLERANCE_PCT;
  const aliases = opts.aliases || {};
  const overrides = opts.scoreOverrides || {};
  const familyInference = opts.familyInference !== false;

  const list = (catalog || []).filter((m) => !minContextWindow || !m.contextWindow || m.contextWindow >= minContextWindow);

  // Paso 1: score de arena (directo o vía alias).
  const scored = list.map((m) => {
    const match = m.cost ? bestArenaMatch(m.id, rows, aliases) : null;
    return {
      id: m.id,
      input: costIn(m),
      output: typeof m.cost?.output === 'number' ? m.cost.output : null,
      contextWindow: m.contextWindow ?? null,
      score: match?.score ?? null,
      arenaRank: match?.rank ?? null,
      variant: match?.variant ?? null,
      arenaSlug: match?.viaSlug ?? null,
      matchedAs: match?.matchedAs ?? null,
      source: match?.source ?? null,
      costKnown: !!m.cost,
      matched: !!match,
    };
  });

  // Paso 2: overrides manuales para SKUs nuevos que arena todavía no rankea.
  for (const a of scored) {
    if (a.score != null) continue;
    const ov = overrides[a.id];
    const val = typeof ov === 'number' ? ov : ov?.score;
    if (typeof val === 'number') {
      a.score = val;
      a.source = 'override';
      a.note = typeof ov === 'object' ? ov.note ?? null : null;
      a.matched = true;
    }
  }

  // Paso 3: inferencia por familia (último recurso, siempre marcada).
  // Hereda del hermano de costo más parecido — no del flagship de la familia,
  // que inflaría el score de un SKU barato. Si el target no tiene costo, toma
  // el mejor de la familia.
  if (familyInference) {
    const siblings = new Map();
    for (const a of scored) {
      if (a.score == null || !Number.isFinite(a.input)) continue;
      const fam = modelFamily(a.id);
      if (!fam) continue;
      if (!siblings.has(fam)) siblings.set(fam, []);
      siblings.get(fam).push(a);
    }
    for (const a of scored) {
      if (a.score != null) continue;
      const sibs = (siblings.get(modelFamily(a.id)) || []).filter((s) => s.id !== a.id);
      if (!sibs.length) continue;
      const hasCost = Number.isFinite(a.input) && a.input > 0;
      const donor = hasCost
        ? sibs.reduce((x, y) => (Math.abs(Math.log(y.input / a.input)) < Math.abs(Math.log(x.input / a.input)) ? y : x))
        : sibs.reduce((x, y) => (scoreOf(y) > scoreOf(x) ? y : x));
      a.score = Math.round(donor.score * FAMILY_DISCOUNT);
      a.source = 'family';
      a.inferred = true;
      a.note = `heredado de ${donor.id} (${donor.score}, $${donor.input}) × ${FAMILY_DISCOUNT}`;
      a.matched = true;
    }
  }

  // Comparador: score desc, pero dentro de la tolerancia gana el más barato.
  const cmp = (a, b) => {
    const d = scoreOf(b) - scoreOf(a);
    const rel = Math.abs(d) / Math.max(scoreOf(b), 1);
    if (rel <= tolerance) return (a.input - b.input) || String(a.id).localeCompare(String(b.id));
    return d;
  };

  const known = scored.filter((a) => a.costKnown);
  const matched = known.filter((a) => a.matched).sort(cmp);
  const unmatched = known.filter((a) => !a.matched).sort((a, b) => a.input - b.input);

  // Pool barato: primero los con score (por score/costo), después los sin score por costo.
  const cheapMatched = matched.filter((a) => a.input <= workerMaxInputCost);
  const cheapUnmatched = unmatched.filter((a) => a.input <= workerMaxInputCost);
  const pool = [...cheapMatched, ...cheapUnmatched];
  if (pool.length < workersPerRole) {
    for (const a of matched) if (!pool.includes(a) && pool.length < workersPerRole) pool.push(a);
  }

  const author = pool.slice(0, workersPerRole).map((a) => a.id);
  // El verifier rota la lista para que, con los mismos índices, nunca coincida con el autor.
  const verifier = author.length > 1 ? [...author.slice(1), author[0]] : [...author];

  const escalationAuthor = matched[0]?.id ?? pool[0]?.id ?? null;
  const escalationVerifier = (matched.find((a) => a.id !== escalationAuthor)
    || pool.find((a) => a.id !== escalationAuthor))?.id ?? null;

  const used = new Set([...author, ...verifier]);
  // Fallback = siguientes baratos (no top de escalado, que son caros).
  const cheapPool = [...cheapMatched, ...cheapUnmatched];
  const fallback = cheapPool.filter((a) => !used.has(a.id)).slice(0, fallbackCount).map((a) => a.id);
  if (fallback.length < fallbackCount) {
    for (const a of matched.concat(unmatched)) {
      if (fallback.length >= fallbackCount) break;
      if (!used.has(a.id) && !fallback.includes(a.id)) fallback.push(a.id);
    }
  }

  const inferred = scored.filter((a) => a.source === 'family').map((a) => a.id);
  return {
    counts: {
      catalog: scored.length,
      matched: scored.filter((a) => a.matched).length,
      unmatched: scored.filter((a) => a.costKnown && !a.matched).length,
      noCost: scored.filter((a) => !a.costKnown).length,
      arenaRows: (rows || []).length,
    },
    author,
    verifier,
    escalationAuthor,
    escalationVerifier,
    fallback,
    inferred,
    ranked: scored.sort((a, b) => scoreOf(b) - scoreOf(a) || a.input - b.input),
  };
}

/** Convierte un ranking en el patch de `config.json` que espera el driver. */
export function configPatchFromRanking(r) {
  const patch = { roles: {}, fallback: {} };
  if (r.author?.length) patch.roles.author = r.author;
  if (r.verifier?.length) patch.roles.verifier = r.verifier;
  if (r.escalationAuthor) patch.roles.escalationAuthor = r.escalationAuthor;
  if (r.escalationVerifier) patch.roles.escalationVerifier = r.escalationVerifier;
  if (r.fallback?.length) patch.fallback.models = r.fallback;
  return patch;
}
