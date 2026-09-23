/** Helpers de fs, JSON y concurrencia. */
import fs from 'node:fs';

export const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
export const appendJsonl = (p, o) => fs.appendFileSync(p, JSON.stringify(o) + '\n');
export const now = () => new Date().toISOString();
export const exists = (p) => fs.existsSync(p);
export function safeReaddir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

export function stripFrontmatter(s) {
  const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? s.slice(m[0].length) : s).trim();
}
export function maskKey(v) {
  if (!v) return '(vacía)';
  return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-3)}` : '***';
}
// Cola FIFO: serializa operaciones que tocan el repo raíz (merge, scribe, tasks.json)
// cuando hay tareas corriendo en paralelo.
export function makeQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}
export async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  await Promise.all(new Array(n).fill(0).map(async () => {
    while (true) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); }
  }));
  return results;
}
