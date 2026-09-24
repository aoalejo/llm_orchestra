/** Runner stub: respuestas canned para correr el loop sin red ni keys. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { now } from './util.mjs';

export function stubModel({ role, prompt, cwd }) {
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1 };
  if (role === 'author') {
    // ORCHESTRA_STUB_TOUCH=1 hace que el author stub deje un cambio real (archivo
    // único), para que el smoke test ejercite commit + merge de punta a punta.
    if (process.env.ORCHESTRA_STUB_TOUCH && cwd) {
      const name = `stub-change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
      try { fs.writeFileSync(path.join(cwd, name), `cambio del author stub @ ${now()}\n`); } catch { /* readonly */ }
    }
    return { code: 0, text: '## RESUMEN\nstub author', usage };
  }
  if (role === 'orchestrator' || role === 'judge') {
    if (/aprob|audit|overturn|rechaz/i.test(prompt)) return { code: 0, text: '{"decision":"APPROVE","commitMessage":"chore(v2): stub","reason":"self-test"}', usage };
    return { code: 0, text: '{"stateMarkdown":"# STATE\\n(stub)","nextTask":"v2-self-test","workOrder":"stub"}', usage };
  }
  if (role === 'verifier' || role === 'security-reviewer') {
    return { code: 0, text: '{"verdict":"PASS","findings":[],"acceptance":[],"counterTests":[],"commandsRun":[]}', usage };
  }
  if (role === 'merge-agent') return { code: 0, text: '## CONFLICTOS\n- (stub) resuelto\n## GATE\nstub → ok', usage };
  if (role === 'scout') return { code: 0, text: '- src/stub.ts:1 — mapa de contexto (stub)', usage };
  if (role === 'scribe') return { code: 0, text: 'done', usage };
  return { code: 0, text: '## RESUMEN\nstub', usage };
}
