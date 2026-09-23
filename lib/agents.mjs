/** Carga de prompts de rol y de `.orchestra/.env`. */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR } from './paths.mjs';
import { exists, stripFrontmatter } from './util.mjs';
import { die } from './log.mjs';

export function readAgent(name) {
  const p = path.join(AGENTS_DIR, `${name}.md`);
  if (!exists(p)) die(`agente no encontrado: ${p}`);
  return stripFrontmatter(fs.readFileSync(p, 'utf8'));
}
export function loadEnv(file) {
  if (!exists(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = val;
  }
}
