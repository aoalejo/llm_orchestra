/** Runner stub: respuestas canned para correr el loop sin red ni keys. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { now } from './util.mjs';

// Cuenta las llamadas al author dentro de este proceso: la usa ORCHESTRA_STUB_TIMEOUT para simular
// que las primeras N se quedaron sin tiempo.
let authorCalls = 0;

export function stubModel({ role, prompt, cwd, model }) {
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1 };
  // ORCHESTRA_STUB_PROMPT_OUT=<archivo>: deja cada prompt en ese archivo. Sirve para asertar que la
  // línea de continuación viaja de verdad en la reanudación.
  if (process.env.ORCHESTRA_STUB_PROMPT_OUT) {
    try { fs.appendFileSync(process.env.ORCHESTRA_STUB_PROMPT_OUT, `--- ${role} (${model}) ---\n${prompt}\n`); } catch { /* noop */ }
  }
  if (role === 'author') {
    // ORCHESTRA_STUB_TOUCH=1 hace que el author stub deje un cambio real (archivo
    // único), para que el smoke test ejercite commit + merge de punta a punta.
    const touch = () => {
      if (!cwd) return;
      const name = `stub-change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
      try { fs.writeFileSync(path.join(cwd, name), `cambio del author stub @ ${now()}\n`); } catch { /* readonly */ }
    };
    // ORCHESTRA_STUB_TIMEOUT=N: las primeras N llamadas al author simulan quedarse sin tiempo (con
    // ORCHESTRA_STUB_TOUCH dejan el diff, que es el caso interesante: timeout CON trabajo hecho).
    // Así se ejercita la rama del timeout sin esperar 30 min.
    authorCalls += 1;
    const n = Number(process.env.ORCHESTRA_STUB_TIMEOUT || 0);
    if (n && authorCalls <= n) {
      if (process.env.ORCHESTRA_STUB_TOUCH) touch();
      return { code: 0, text: '', timedOut: true, usage };
    }
    if (process.env.ORCHESTRA_STUB_TOUCH) touch();
    return { code: 0, text: '## RESUMEN\nstub author', usage };
  }
  if (role === 'orchestrator' || role === 'judge') {
    if (/aprob|audit|overturn|rechaz/i.test(prompt)) return { code: 0, text: '{"decision":"APPROVE","commitMessage":"chore(v2): stub","reason":"self-test"}', usage };
    return { code: 0, text: '{"stateMarkdown":"# STATE\\n(stub)","nextTask":"v2-self-test","workOrder":"stub"}', usage };
  }
  if (role === 'verifier' || role === 'security-reviewer') {
    // ORCHESTRA_STUB_VERIFIER_ERROR=<modelo>: ese modelo simula un corte de TRANSPORTE del
    // proveedor (400 por contexto inflado), para ejercitar el reintento de `verifyWithRetry`
    // sin red: el loop debe reintentar con otro modelo, no contar FAIL.
    if (process.env.ORCHESTRA_STUB_VERIFIER_ERROR && process.env.ORCHESTRA_STUB_VERIFIER_ERROR === model) {
      return { code: 0, text: '', stopReason: 'error', errorMessage: '400 event: error\n\ndata: {}', usage };
    }
    // ORCHESTRA_STUB_VERIFIER_UNKNOWN=1: el verifier contesta UNKNOWN sin findings (un veredicto VÁLIDO
    // que no decide nada). El loop no puede tirar el trabajo por eso.
    if (process.env.ORCHESTRA_STUB_VERIFIER_UNKNOWN) {
      return { code: 0, text: '{"verdict":"UNKNOWN","findings":[],"acceptance":[],"counterTests":[],"commandsRun":[]}', usage };
    }
    return { code: 0, text: '{"verdict":"PASS","findings":[],"acceptance":[],"counterTests":[],"commandsRun":[]}', usage };
  }
  if (role === 'merge-agent') return { code: 0, text: '## CONFLICTOS\n- (stub) resuelto\n## GATE\nstub → ok', usage };
  if (role === 'scout') return { code: 0, text: '- src/stub.ts:1 — mapa de contexto (stub)', usage };
  if (role === 'scribe') return { code: 0, text: 'done', usage };
  return { code: 0, text: '## RESUMEN\nstub', usage };
}
