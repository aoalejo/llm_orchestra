/** Pool de cuentas A/B y rotación. */
import process from 'node:process';
import { maskKey } from './util.mjs';

export function makeKeyState() { return { workerKeyIdx: 0, exhausted: new Set() }; }

export function pickKey(config, ks, role) {
  if (role === 'orchestrator' || role === 'judge') return { name: config.keys.orchestrator, value: process.env[config.keys.orchestrator] };
  const names = config.keys.workers.filter((n) => process.env[n]);
  for (let i = 0; i < names.length; i++) {
    const name = names[(ks.workerKeyIdx + i) % names.length];
    if (!ks.exhausted.has(name)) { ks.workerKeyIdx = (ks.workerKeyIdx + i + 1) % names.length; return { name, value: process.env[name] }; }
  }
  // Fallback decidido por el orquestador: reutilizar la cuenta A para workers.
  if (ks.useOrchestratorKey) return { name: config.keys.orchestrator, value: process.env[config.keys.orchestrator] };
  return null;
}
export function keysStatus(config) {
  const rows = [
    ['orchestrator', config.keys.orchestrator, process.env[config.keys.orchestrator]],
    ...config.keys.workers.map((n) => ['worker', n, process.env[n]]),
  ];
  for (const [role, name, val] of rows) console.log(`${role.padEnd(13)} ${name.padEnd(34)} ${maskKey(val)}`);
}
