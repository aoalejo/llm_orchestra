#!/usr/bin/env node
/**
 * `pi` falso para el smoke de proveedores directos (P00095): habla el stream `--mode json` justo lo
 * necesario para que el runner real lo parsee. Sin red.
 *
 * Variables (las lee de su entorno; el runner agrega ORCHESTRA_ROLE):
 *   FAKE_PI_COUNTER=<prefijo>   cuenta las invocaciones por rol en `<prefijo>.<rol>` (para asertar reintentos)
 *   FAKE_PI_ERROR=429|402|stall falla con eso …
 *   FAKE_PI_ROLE=<rol>          … sólo en ese rol (default: author)
 *   FAKE_PI_FAIL_FIRST=<n>      … sólo las primeras n invocaciones de ese rol (default: todas)
 * Sin error: el author deja un archivo en el cwd, el verifier contesta PASS, el scout un mapa.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const role = process.env.ORCHESTRA_ROLE || '';
let n = 1;
if (process.env.FAKE_PI_COUNTER) {
  const f = `${process.env.FAKE_PI_COUNTER}.${role}`;
  try { n = Number(fs.readFileSync(f, 'utf8')) + 1; } catch { n = 1; }
  fs.writeFileSync(f, String(n));
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } };

const err = process.env.FAKE_PI_ERROR;
const failsHere = err && role === (process.env.FAKE_PI_ROLE || 'author')
  && (!process.env.FAKE_PI_FAIL_FIRST || n <= Number(process.env.FAKE_PI_FAIL_FIRST));

out({ type: 'agent_start' });
out({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });

if (failsHere && err === 'stall') {
  // DeepSeek en cola: acepta el pedido y no emite nada del modelo. Se autolimita por si nadie lo mata.
  setTimeout(() => process.exit(2), 30000);
  setInterval(() => {}, 1000);
} else if (failsHere) {
  process.stderr.write(err === '402' ? '402 Payment Required: insufficient balance\n' : '429 Too Many Requests: rate limit exceeded\n');
  process.exit(1);
} else {
  let text = 'hecho';
  if (role === 'author') {
    fs.writeFileSync(path.join(process.cwd(), `fake-change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`), 'cambio del pi falso\n');
    text = '## RESUMEN\nfake author';
  } else if (role === 'verifier' || role === 'security-reviewer') {
    // P00096: FAKE_PI_VERDICT=FAIL contesta FAIL con findings; FAKE_PI_MUTATE='a.ts,b.ts' crea/
    // modifica esos archivos en el cwd (el worktree bajo QA) para ejercitar la guarda de permisos D2.
    // FAKE_PI_COMMIT=1 hace git add + git commit para probar la detección de commits del verifier.
    const { execSync } = await import('node:child_process');

    for (const f of String(process.env.FAKE_PI_MUTATE || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      fs.appendFileSync(path.join(process.cwd(), f), 'qa del verifier falso\n');
    }

    // FAKE_PI_GITMV='a.js:b.js' hace `git mv a.js b.js` (rename staged: la ruta vieja no aparece sola en porcelain).
    for (const pair of String(process.env.FAKE_PI_GITMV || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [from, to] = pair.split(':');
      try { execSync(`git mv "${from}" "${to}"`, { cwd: process.cwd(), stdio: 'pipe' }); } catch { /* noop */ }
    }

    // FAKE_PI_INDEXPOISON='a.md': escribe contenido malicioso, `git add`, y restaura los bytes originales en el
    // worktree (el índice queda envenenado sin que cambie el contenido del archivo).
    for (const f of String(process.env.FAKE_PI_INDEXPOISON || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const p = path.join(process.cwd(), f);
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, 'contenido malicioso del verifier\n');
      try { execSync(`git add -- "${f}"`, { cwd: process.cwd(), stdio: 'pipe' }); } catch { /* noop */ }
      fs.writeFileSync(p, orig);
    }
    // FAKE_PI_CHECKOUT='main': cambia de rama (y con FAKE_PI_COMMIT commitea en ESA rama).
    if (process.env.FAKE_PI_CHECKOUT) {
      try { execSync(`git checkout -q "${process.env.FAKE_PI_CHECKOUT}"`, { cwd: process.cwd(), stdio: 'pipe' }); } catch { /* noop */ }
    }
    // FAKE_PI_ADDALL=1: `git add -A` sin tocar bytes (deja staged el trabajo del autor).
    if (process.env.FAKE_PI_ADDALL) {
      try { execSync('git add -A', { cwd: process.cwd(), stdio: 'pipe' }); } catch { /* noop */ }
    }

    // FAKE_PI_CHMOD='a.md,b.sh': chmod 0o444 (read-only) sin tocar bytes → cambio de MODO del verifier.
    for (const f of String(process.env.FAKE_PI_CHMOD || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      try { fs.chmodSync(path.join(process.cwd(), f), 0o444); } catch { /* noop */ }
    }

    // FAKE_PI_LINK='a.md' + FAKE_PI_LINK_TARGET=<ruta externa>: reemplaza el archivo por un symlink
    // (o hardlink si el host no permite symlinks) a un path externo. Prueba que la restauración no
    // escribe A TRAVÉS del link.
    if (process.env.FAKE_PI_LINK && process.env.FAKE_PI_LINK_TARGET) {
      const p = path.join(process.cwd(), process.env.FAKE_PI_LINK);
      try { fs.rmSync(p, { force: true }); } catch { /* noop */ }
      try { fs.symlinkSync(process.env.FAKE_PI_LINK_TARGET, p); }
      catch { try { fs.linkSync(process.env.FAKE_PI_LINK_TARGET, p); } catch { /* noop */ } }
    }

    // FAKE_PI_LINKDIR='sub' + FAKE_PI_LINKDIR_TARGET=<dir externo>: reemplaza un DIRECTORIO del
    // worktree por un enlace al directorio externo. Prueba que la restauración no escribe A TRAVÉS
    // del enlace del padre (no debe borrar/pisar el fichero externo).
    if (process.env.FAKE_PI_LINKDIR && process.env.FAKE_PI_LINKDIR_TARGET) {
      const p = path.join(process.cwd(), process.env.FAKE_PI_LINKDIR);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
      try { fs.symlinkSync(process.env.FAKE_PI_LINKDIR_TARGET, p, process.platform === 'win32' ? 'junction' : undefined); }
      catch { /* noop */ }
    }

    if (process.env.FAKE_PI_COMMIT) {
      try {
        execSync('git add -A', { cwd: process.cwd(), stdio: 'pipe' });
        execSync('git commit -m "commit del verifier falso"', { cwd: process.cwd(), stdio: 'pipe' });
      } catch { /* noop */ }
    }

    text = process.env.FAKE_PI_VERDICT === 'FAIL'
      ? '{"verdict":"FAIL","findings":[{"severity":"high","file":"clean.js","line":1,"problem":"hallazgo del verifier falso"}],"acceptance":[],"counterTests":[],"commandsRun":[]}'
      : '{"verdict":"PASS","findings":[],"acceptance":[],"counterTests":[],"commandsRun":[]}';
  } else if (role === 'scout') {
    text = '- src/fake.js:1 — mapa de contexto (pi falso)';
  }
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop', model: 'fake' } });
  out({ type: 'agent_end' });
}
