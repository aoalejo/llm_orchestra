/** Lógica pura y testeable del driver (sin red). */
import path from 'node:path';
import { O, ROOT } from './paths.mjs';

export function extractLastJson(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return JSON.parse(fences[i][1]); } catch { /* sigue */ }
  }
  // Objetos JSON de nivel raíz (se ignoran llaves anidadas y llaves dentro de strings).
  const candidates = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch { /* sigue */ }
  }
  return null;
}

export function findingsSignature(verdicts) {
  return JSON.stringify(
    (verdicts || [])
      .flatMap((v) => (v.findings || []).map((f) => `${f.file || '?'}:${f.line || '?'}:${(f.problem || f.reason || '').slice(0, 80)}`))
      .sort(),
  );
}

// Conflicto de rutas por SEGMENTOS: "apps/x/orders" no debe matchear
// "apps/x/orders-v2/f.ts" (un startsWith textual daría falsos positivos).
export function pathsConflict(a, b) {
  const seg = (p) => String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  const A = seg(a); const B = seg(b);
  if (!A.length || !B.length) return false;
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) return false;
  return true;
}
export function isProtected(config, task) {
  const paths = config.protectedPaths || [];
  return (task.scope || []).some((s) => paths.some((p) => pathsConflict(s, p)));
}
// Versión estricta: evalúa los archivos que el diff realmente modificó (no solo el scope declarado).
export function isProtectedChange(config, files) {
  const paths = config.protectedPaths || [];
  return (files || []).some((f) => paths.some((p) => pathsConflict(f, p)));
}
// Comandos de gate de una tarea: sus targets o todos los targets válidos (ignora claves $comment).
export function gateCommands(config, task) {
  const gates = config.gates || {};
  const targets = task.targets?.length
    ? task.targets
    : Object.keys(gates).filter((k) => !k.startsWith('$') && Array.isArray(gates[k]));
  return targets.flatMap((t) => gates[t] || []);
}

export function workOrderText(task, ctx) {
  return [
    `WORK ORDER`,
    `id: ${task.id}`,
    `título: ${task.title}`,
    `riesgo: ${task.risk}`,
    `contrato/spec: ${task.contractRef ?? 'N/A'}`,
    `targets de gate: ${(task.targets || []).join(', ')}`,
    ``,
    `SCOPE (solo estos archivos):`,
    ...(task.scope || []).map((s) => `- ${s}`),
    ``,
    `ACCEPTANCE CRITERIA:`,
    ...(task.acceptance || []).map((a, i) => `${i + 1}. ${a}`),
    ``,
    ctx?.scoutMap ? `MAPA DE CONTEXTO (scout):\n${ctx.scoutMap}\n` : '',
    `STATE global: ${path.join(O, 'STATE.md')}`,
    `Directorio de trabajo: ${ctx?.workdir || ROOT}`,
  ].filter(Boolean).join('\n');
}

export function pickAuthorVerifier(config, cycle, maxCycles, forced = null) {
  const authors = config.roles.author;
  const verifiers = config.roles.verifier;
  const last = cycle === maxCycles;
  const author = forced?.author
    || (last && config.roles.escalationAuthor ? config.roles.escalationAuthor : authors[(cycle - 1) % authors.length]);
  let verifier = forced?.verifier
    || (last && config.roles.escalationVerifier ? config.roles.escalationVerifier : verifiers[(cycle - 1) % verifiers.length]);
  if (verifier === author) verifier = verifiers.find((m) => m !== author) || verifiers[cycle % verifiers.length];
  return { author, verifier, last };
}

// Par de modelos de fallback (cuando se agota la cuenta B y el orquestador lo permite).
export function pickFallbackPair(config, cycle) {
  const fb = config.fallback?.models || [];
  if (!fb.length) return null;
  const author = fb[(cycle - 1) % fb.length];
  const verifier = fb.find((m) => m !== author) || author;
  return { author, verifier };
}

// Suma usage al estado de la tarea (costo + tokens) y devuelve el costo.
export function recordUsage(state, usage) {
  if (!usage) return 0;
  state.spentUsd = (state.spentUsd || 0) + (usage.cost || 0);
  state.tokens = state.tokens || { input: 0, output: 0 };
  state.tokens.input = (state.tokens.input || 0) + (usage.input || 0);
  state.tokens.output = (state.tokens.output || 0) + (usage.output || 0);
  return usage.cost || 0;
}

// Corte por presupuesto: costo y tokens de entrada/salida.
export function budgetStatus(config, state) {
  const b = config.budget || {};
  const usd = state.spentUsd || 0;
  const input = state.tokens?.input || 0;
  const output = state.tokens?.output || 0;
  if (b.maxUsdPerTask && usd > b.maxUsdPerTask) return { ok: false, reason: `costo $${usd.toFixed(4)} > $${b.maxUsdPerTask}` };
  if (b.maxInputTokensPerTask && input > b.maxInputTokensPerTask) return { ok: false, reason: `input tokens ${input} > ${b.maxInputTokensPerTask}` };
  if (b.maxOutputTokensPerTask && output > b.maxOutputTokensPerTask) return { ok: false, reason: `output tokens ${output} > ${b.maxOutputTokensPerTask}` };
  return { ok: true };
}

export function shouldMetaReview(config, highRisk, rng = Math.random) {
  const mr = config.metaReview || {};
  if (!mr.enabled) return false;
  if (mr.alwaysForHighRisk && highRisk) return true;
  return rng() < (mr.sampleRate || 0);
}

/* ─────────────────────────────── runtime ───────────────────────────────────── */

// Señales de cuenta agotada, a nivel TRANSPORTE (stderr / errorMessage).
// Deliberadamente NO se aplica al texto del modelo: un author que trabaja en
// pagos escribe "402", "quota" o "insufficient funds" como parte del código, y
// eso no significa que la key se haya agotado (antes marcaba la cuenta muerta).
export const EXHAUST_RE = /(quota (exceeded|exhausted|remaining)|insufficient (balance|credit|credits|quota)|rate.?limit(ed| exceeded)?|too many requests|\b(401|402|429)\b|unauthoriz|invalid api key|no credits|credit balance is too low|billing (issue|error)|payment required|exhausted)/i;

export function detectExhausted({ stderr = '', errorMessage = null } = {}) {
  return EXHAUST_RE.test(`${stderr ?? ''}\n${errorMessage ?? ''}`);
}
