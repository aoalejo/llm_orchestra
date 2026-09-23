/**
 * Estimación de costo restante a partir del ledger (función pura).
 *
 * No hay saldo absoluto; lo que sí hay es (a) el costo real ya gastado por tarea/
 * rol (ledger) y (b) el % de cuota consumido (`lib/usage.mjs`). Este estimador da
 * el USD esperado para lo que queda, para que el chat decida.
 */

/**
 * @param {object} o
 *   summary          salida de `summarizeLedger` (byTask, byRole)
 *   remainingTasks   tareas que faltan
 *   maxCycles        ciclos máximos por tarea (fallback si no hay historial por tarea)
 */
export function estimateRemaining({ summary, remainingTasks = 1, maxCycles = 4 } = {}) {
  const tasks = Object.values(summary?.byTask || {});
  const done = tasks.length;
  const total = tasks.reduce((a, t) => a + (t.cost || 0), 0);
  const avgPerTask = done ? total / done : null;

  const byRole = summary?.byRole || {};
  const authorCost = byRole.author?.cost ?? 0;
  const verifierCost = byRole.verifier?.cost ?? 0;
  const authorCalls = byRole.author?.calls ?? 0;
  const avgPerCycle = authorCalls ? (authorCost + verifierCost) / authorCalls : null;

  const perTask = avgPerTask ?? (avgPerCycle != null ? avgPerCycle * maxCycles : null);
  const usd = perTask != null ? perTask * Math.max(0, remainingTasks) : null;
  const round = (n) => (n == null ? null : Number(n.toFixed(6)));
  return {
    usd: round(usd),
    perTaskUsd: round(perTask),
    samples: done,
    remainingTasks,
    source: avgPerTask != null ? 'ledger/avgPerTask' : (avgPerCycle != null ? 'ledger/avgPerCycle' : 'none'),
  };
}
