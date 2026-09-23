/**
 * Rutas y constantes del runtime. Se calculan una vez al cargar el módulo:
 * el driver siempre corre desde la raíz del proyecto consumidor.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SELF_DIR = path.dirname(fileURLToPath(import.meta.url)); // lib/
export const PKG_DIR = path.resolve(SELF_DIR, '..');
export const TEMPLATES_DIR = path.join(PKG_DIR, 'templates');
export const ROOT = process.cwd();
export const O = path.join(ROOT, '.orchestra');
// Agentes: override de proyecto (.pi/agents) → agentes del paquete (global).
export const AGENTS_DIR = process.env.ORCHESTRA_AGENTS_DIR
  || (fs.existsSync(path.join(ROOT, '.pi', 'agents')) ? path.join(ROOT, '.pi', 'agents') : path.join(PKG_DIR, 'agents'));
export const RUNS = path.join(O, 'runs');
export const SCRATCH = path.join(O, 'scratch');
export const WORKTREES = path.join(O, 'worktrees');
export const LEDGER = path.join(O, 'ledger.jsonl');
