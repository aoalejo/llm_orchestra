/** Logging con flags globales (verbose / quiet para --json). */
import process from 'node:process';

export const flags = { verbose: false, quiet: false };
export const log = (...a) => { if (!flags.quiet) console.log('[orchestra]', ...a); };
export const vlog = (...a) => { if (flags.verbose) console.log('[orchestra][v]', ...a); };
export const warn = (...a) => console.warn('[orchestra][warn]', ...a);
export const die = (m) => { console.error('[orchestra][error]', m); process.exit(1); };
