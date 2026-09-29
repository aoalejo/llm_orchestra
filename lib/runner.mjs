/** Ejecución de procesos y llamadas a pi (real o stub). */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ROOT, RUNS } from './paths.mjs';
import { ensureDir, exists, now, writeJson } from './util.mjs';
import { flags, log, warn } from './log.mjs';
import { detectExhausted, detectUnusableModel } from './pure.mjs';
import { stubModel } from './stub.mjs';

// Timeout de cada llamada a `pi` (config `loop.piTimeoutMs`, default 15 min).
let PI_TIMEOUT_MS = 15 * 60 * 1000;
export function setPiTimeout(ms) { if (Number.isFinite(ms) && ms > 0) PI_TIMEOUT_MS = ms; }
export function getPiTimeout() { return PI_TIMEOUT_MS; }

/**
 * El .js que lanza un shim de npm (`pi.cmd`), o null. El shim termina en
 * `"%_prog%" "%dp0%\node_modules\...\cli.js" %*`.
 */
export function shimTarget(shimText, shimDir) {
  const m = /"%dp0%[\\/]+([^"]+?\.m?c?js)"/i.exec(String(shimText));
  return m ? path.join(shimDir, m[1].replace(/[\\/]+/g, path.sep)) : null;
}

function findOnPath(name, env) {
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, name);
    if (exists(f)) return f;
  }
  return null;
}

/**
 * Cómo lanzar `pi`. En Windows NUNCA por shell: `spawn(..., { shell: true })` une los args con espacios SIN
 * comillas, así que cmd.exe parte el system prompt en palabras (cada una llegaba como un mensaje de usuario
 * distinto: "el", "**scribe**.", ...) y CORTA la línea en el primer salto de línea: se perdían
 * `--session-dir` (la sesión caía en el árbol del usuario: ticket 0057 de pi-web) y el prompt real.
 * Por eso se resuelve el shim `pi.cmd` a `node <cli.js>` y se lanza directo.
 */
export function resolvePi(config, { platform = process.platform, env = process.env } = {}) {
  const candidates = [env.ORCHESTRA_PI_CLI, config.piCli].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) return { command: process.execPath, prefix: [c], shell: false, label: c };
  }
  if (platform === 'win32') {
    const shim = findOnPath('pi.cmd', env);
    if (shim) {
      try {
        const dir = path.dirname(shim);
        const js = shimTarget(fs.readFileSync(shim, 'utf8'), dir);
        if (js && exists(js)) {
          const node = exists(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : process.execPath;
          return { command: node, prefix: [js], shell: false, label: js };
        }
      } catch { /* cae al shell */ }
    }
    warn('pi.cmd no se pudo resolver a un .js: se lanza por shell y cmd.exe corta los prompts (definí ORCHESTRA_PI_CLI o piCli)');
  }
  const cmd = platform === 'win32' ? 'pi.cmd' : 'pi';
  return { command: cmd, prefix: [], shell: true, label: cmd };
}

/**
 * Descendientes de `rootPid` según `procs` ([{pid, ppid, created}]), creados después de `notBefore`.
 * Se sigue el ParentProcessId AUNQUE el padre ya no exista: en Windows un hijo huérfano conserva el ppid del
 * padre muerto, y esos son justo los que dejan el cwd de un worktree tomado (ticket 0068 de pi-web).
 */
export function descendantsOf(rootPid, procs, notBefore = 0, selfPid = process.pid) {
  const seen = new Set([rootPid]);
  const out = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (seen.has(p.pid) || p.pid === selfPid || !seen.has(p.ppid) || (p.created && p.created < notBefore)) continue;
      seen.add(p.pid); out.push(p); grew = true;
    }
  }
  return out;
}

function listProcesses() {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }), $_.Name }"]]
      : ['ps', ['-e', '-o', 'pid=,ppid=,comm=']];
    let out = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { return resolve([]); }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const rows = out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 3 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]));
      resolve(rows.map((f) => (process.platform === 'win32'
        ? { pid: +f[0], ppid: +f[1], created: +f[2], name: f.slice(3).join(' ') }
        : { pid: +f[0], ppid: +f[1], created: 0, name: f.slice(2).join(' ') })));
    });
  });
}

/** Mata lo que quedó vivo de un run (servers de prueba, sondas, hijos RPC) una vez terminado su proceso raíz. */
export async function reapDescendants(rootPid, startedAt) {
  if (!rootPid) return [];
  const victims = descendantsOf(rootPid, await listProcesses(), startedAt - 2000);
  for (const v of victims) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(v.pid), '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(v.pid, 'SIGKILL');
    } catch { /* ya murió */ }
  }
  return victims;
}

export function runProcess(command, args, { cwd = ROOT, env, shell = false, onLine, onStderr, timeoutMs = 0, reap = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, out: '', err: String(e), spawnError: String(e), timedOut: false });
    }
    let out = '', err = '', buf = '', timedOut = false;
    const startedAt = Date.now();

    // En Windows `child.kill` mata el wrapper cmd.exe pero puede dejar vivo el
    // node.exe de pi: taskkill /T baja todo el árbol.
    const killTree = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* noop */ } }
    };

    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(); }, timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => {
      const s = d.toString(); out += s;
      if (onLine) { buf += s; const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ''; for (const l of lines) onLine(l); }
    });
    child.stderr.on('data', (d) => { const s = d.toString(); err += s; if (onStderr) onStderr(s); });
    child.on('close', async (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && buf.trim()) onLine(buf);
      let reaped = [];
      if (reap) { try { reaped = await reapDescendants(child.pid, startedAt); } catch { /* best effort */ } }
      if (reaped.length) warn(`  quedaron vivos ${reaped.length} proceso(s) del run, se matan: ${reaped.map((v) => `${v.name}#${v.pid}`).join(', ')}`);
      resolve({ code: timedOut ? 124 : (code ?? 0), out, err, timedOut, reaped: reaped.length });
    });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: 1, out, err, spawnError: e.message, timedOut }); });
  });
}

/** Rutas hermanas al logFile: stream en vivo y stderr crudo. */
export function streamPathFor(logFile) { return logFile ? logFile.replace(/\.json$/i, '.stream.jsonl') : null; }
export function stderrPathFor(logFile) { return logFile ? logFile.replace(/\.json$/i, '.stderr.log') : null; }

/** `runs/<task>/heartbeat.json` para que un watchdog externo detecte cuelgues. */
export function heartbeatPathFor(logFile) {
  if (!logFile) return path.join(RUNS, 'heartbeat.json');
  const rel = path.relative(RUNS, logFile);
  const first = rel.split(path.sep)[0];
  if (!first || first.startsWith('..') || first.endsWith('.json')) return path.join(RUNS, 'heartbeat.json');
  return path.join(RUNS, first, 'heartbeat.json');
}

/**
 * Args de pi. Por defecto usa un `--session-dir` efímero por rol (necesario para
 * SoL-Pi, que hace throw si no hay session dir) en vez de `--no-session`; se
 * limpia al terminar salvo `ctx.keepSessionDir`. Con `ctx.noSession` vuelve al modo viejo.
 */
export function buildPiArgs(ctx) {
  const { provider, model, apiKey, systemPrompt, prompt, tools, thinking, logFile } = ctx;
  const args = ['--mode', 'json', '-p', '--provider', provider];
  if (model) args.push('--model', model);
  if (apiKey) args.push('--api-key', apiKey);
  if (thinking) args.push('--thinking', thinking);
  if (tools && tools.length) args.push('--tools', tools.join(','));
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  const dirName = String(ctx.role || 'pi').replace(/[^a-z0-9_-]+/gi, '_');
  const sessionDir = ctx.sessionDir ?? (logFile ? path.join(path.dirname(logFile), 'sessions', dirName) : null);
  if (ctx.noSession || !sessionDir) args.push('--no-session');
  else args.push('--session-dir', sessionDir);
  args.push(promptArgFor(args, prompt, logFile, { shell: !!ctx.pi?.shell }));
  return { args, sessionDir: ctx.noSession ? null : sessionDir };
}

/**
 * El prompt como argumento inline… o como `@archivo` si no entra en la línea de
 * comandos. En Windows el tope es 8191 chars con `shell:true` (cmd.exe) y 32767
 * sin shell: un work order con el mapa del scout (chunks del índice) + acceptance
 * lo pasa fácil, y el síntoma es feo: pi ni arranca (exit 1, 0 turnos, stderr
 * "La línea de comandos es demasiado larga") y el autor devuelve diff vacío.
 */
export function promptArgFor(args, prompt, logFile, { shell = false, platform = process.platform } = {}) {
  const text = String(prompt ?? '');
  const limit = platform === 'win32' ? (shell ? 7000 : 28000) : 120000;
  const used = args.reduce((n, a) => n + String(a).length + 1, 0);
  if (used + text.length + 16 <= limit) return text;
  const dir = logFile ? path.dirname(logFile) : os.tmpdir();
  ensureDir(dir);
  const file = path.join(dir, `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.md`);
  fs.writeFileSync(file, text);
  return `@${file}`;
}

export async function runPi(ctx) {
  const { pi, model, logFile } = ctx;
  const { args, sessionDir } = buildPiArgs(ctx);
  if (flags.verbose) {
    const chars = args.reduce((n, a) => n + String(a).length + 1, 0);
    log(`  [${ctx.role ?? 'pi'}] spawn ${pi.command} (shell=${!!pi.shell}) args=${args.length} chars=${chars}`);
  }

  const timeoutMs = ctx.timeoutMs ?? PI_TIMEOUT_MS;
  const streamFile = streamPathFor(logFile);
  const stderrFile = stderrPathFor(logFile);
  const hbFile = heartbeatPathFor(logFile);
  const startedAt = Date.now();
  for (const f of [streamFile, stderrFile]) {
    if (!f) continue;
    ensureDir(path.dirname(f));
    try { fs.writeFileSync(f, ''); } catch { /* readonly */ }
  }
  if (sessionDir) ensureDir(sessionDir);

  const events = [];
  let lastLineAt = Date.now();
  let lastEvent = 'inicio';
  // Heartbeat: archivo para watchdog externo + aviso en --verbose si no hay datos.
  const beatFn = () => {
    const silentMs = Date.now() - lastLineAt;
    try { writeJson(hbFile, { ts: now(), pid: process.pid, role: ctx.role ?? null, model: model ?? null, logFile: logFile ?? null, streamFile, silentMs, startedAt, timeoutMs }); } catch { /* noop */ }
    if (flags.verbose && silentMs >= 30000) log(`  [${ctx.role ?? 'pi'}] sin datos desde ${Math.round(silentMs / 1000)}s (último: ${lastEvent})`);
  };
  beatFn();
  const beat = setInterval(beatFn, 30000);
  if (typeof beat.unref === 'function') beat.unref();

  let res;
  try {
    res = await runProcess(pi.command, [...pi.prefix, ...args], {
      shell: pi.shell,
      cwd: ctx.cwd || ROOT,
      timeoutMs,
      reap: true,
      env: { ...process.env, ORCHESTRA_ROLE: ctx.role || '', ORCHESTRA_TASK: ctx.taskId || '', ORCHESTRA_LOG: logFile || '' },
      onLine: (line) => {
        if (!line.trim()) return;
        lastLineAt = Date.now();
        if (streamFile) { try { fs.appendFileSync(streamFile, line + '\n'); } catch { /* noop */ } }
        try {
          const ev = JSON.parse(line);
          events.push(ev);
          if (ev.type) {
            const detail = ev.toolName || ev.name || ev.message?.toolName || null;
            lastEvent = detail ? `${ev.type}:${detail}` : ev.type;
          }
        } catch { /* línea no-JSON: queda en el stream */ }
      },
      onStderr: (chunk) => { if (stderrFile) { try { fs.appendFileSync(stderrFile, chunk); } catch { /* noop */ } } },
    });
  } finally {
    clearInterval(beat);
    if (sessionDir && !ctx.keepSessionDir) { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* noop */ } }
  }

  let text = ''; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let stopReason = null, errorMessage = null, modelUsed = model ?? null;
  for (const ev of events) {
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const m = ev.message; usage.turns++;
      if (m.usage) { usage.input += m.usage.input || 0; usage.output += m.usage.output || 0; usage.cacheRead += m.usage.cacheRead || 0; usage.cacheWrite += m.usage.cacheWrite || 0; usage.cost += m.usage.cost?.total || 0; }
      if (m.model) modelUsed = m.model;
      if (m.stopReason) stopReason = m.stopReason;
      if (m.errorMessage) errorMessage = m.errorMessage;
      const t = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (t) text = t;
    }
  }
  // El log SIEMPRE se escribe (éxito, timeout o error): un cuelgue debe dejar evidencia.
  const durationMs = Date.now() - startedAt;
  if (logFile) {
    const safeArgs = args.map((a, i) => (args[i - 1] === '--api-key' ? '***' : a));
    ensureDir(path.dirname(logFile));
    try {
      fs.writeFileSync(logFile, JSON.stringify({
        model, code: res.code, timedOut: !!res.timedOut, durationMs,
        usage, stopReason, errorMessage, stderr: res.err, text, args: safeArgs,
        streamFile, stderrFile,
      }, null, 2));
    } catch { /* readonly */ }
  }
  if (res.timedOut) warn(`pi sin respuesta: timeout de ${Math.round(timeoutMs / 1000)}s en ${ctx.role ?? '?'} (${Math.round(durationMs / 1000)}s) → ${streamFile ?? logFile ?? '(sin log)'}`);
  return {
    code: res.code, text, usage, stopReason, errorMessage, stderr: res.err,
    spawnError: res.spawnError, exhausted: detectExhausted({ stderr: res.err, errorMessage }),
    unusableModel: detectUnusableModel({ stderr: res.err, errorMessage }),
    modelUsed, timedOut: !!res.timedOut, streamFile, stderrFile, durationMs,
  };
}

export async function callModel(ctx) {
  if (ctx.runner === 'stub') return stubModel(ctx);
  return runPi(ctx);
}

export async function runGate(commands, logFile, cwd, timeoutMs = 20 * 60 * 1000) {
  const results = []; let ok = true; let logText = `# gate ${now()}\n`;
  for (const cmd of commands) {
    log(`  gate: ${cmd}`);
    const r = await runProcess(cmd, [], { shell: true, cwd, timeoutMs, reap: true });
    const passed = r.code === 0;
    results.push({ command: cmd, code: r.code, passed });
    logText += `\n$ ${cmd}\n[exit ${r.code}]\n${r.out}\n${r.err}\n`;
    if (!passed) { ok = false; break; }
  }
  fs.writeFileSync(logFile, logText);
  return { ok, results };
}

export async function writeDiff(cwd, file) {
  await runProcess('git', ['add', '-A', '-N'], { cwd });
  const r = await runProcess('git', ['diff', '--no-color'], { cwd });
  fs.writeFileSync(file, r.out || '');
  return r.out || '';
}

export async function changedFiles(cwd) {
  await runProcess('git', ['add', '-A', '-N'], { cwd });
  const r = await runProcess('git', ['diff', '--name-only'], { cwd });
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
