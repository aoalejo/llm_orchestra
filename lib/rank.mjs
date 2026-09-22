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
 */
import { matchModel } from './leaderboard.mjs';

const costIn = (m) => (typeof m.cost?.input === 'number' ? m.cost.input : Infinity);
const scoreOf = (a) => (typeof a.score === 'number' ? a.score : -1);

/**
 * @param {Array} catalog  [{id, cost:{input,output}, contextWindow}]
 * @param {Array} rows     filas del leaderboard (leaderboard.mjs)
 * @param {object} opts
 *   workerMaxInputCost  costo máx USD/M input para entrar a la rotación (default 0.5)
 *   workersPerRole      cupos por rol autor/verifier (default 3)
 *   fallbackCount       modelos de fallback (default 3)
 *   minContextWindow    ignora modelos con contexto menor a esto (default 0)
 */
export function rankModels(catalog, rows, opts = {}) {
  const workerMaxInputCost = opts.workerMaxInputCost ?? 0.5;
  const workersPerRole = opts.workersPerRole ?? 3;
  const fallbackCount = opts.fallbackCount ?? 3;
  const minContextWindow = opts.minContextWindow ?? 0;

  const annotated = (catalog || [])
    .filter((m) => !minContextWindow || !m.contextWindow || m.contextWindow >= minContextWindow)
    .map((m) => {
      const match = m.cost ? matchModel(m.id, rows || []) : null;
      return {
        id: m.id,
        input: costIn(m),
        output: typeof m.cost?.output === 'number' ? m.cost.output : null,
        contextWindow: m.contextWindow ?? null,
        score: match?.score ?? null,
        arenaRank: match?.rank ?? null,
        variant: match?.variant ?? null,
        costKnown: !!m.cost,
        matched: !!match,
      };
    });

  const matched = annotated.filter((a) => a.matched).sort((a, b) => scoreOf(b) - scoreOf(a) || a.input - b.input);
  const unmatched = annotated.filter((a) => !a.matched && a.costKnown).sort((a, b) => a.input - b.input);

  // Pool barato: primero los matcheados por score, después los sin match por costo.
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
    || pool.find((a) => a.id !== escalationAuthor) || matched[1])?.id ?? null;

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

  return {
    counts: { catalog: annotated.length, matched: matched.length, unmatched: unmatched.length, arenaRows: (rows || []).length },
    author,
    verifier,
    escalationAuthor,
    escalationVerifier,
    fallback,
    ranked: matched.concat(unmatched),
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
