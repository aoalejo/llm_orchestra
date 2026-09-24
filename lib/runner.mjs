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

export function resolvePi(config) {
  const candidates = [process.env.ORCHESTRA_PI_CLI, config.piCli].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) return { command: process.execPath, prefix: [c], shell: false, label: c };
  }
  const cmd = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  return { command: cmd, prefix: [], shell: true, label: cmd };
}

export function runProcess(command, args, { cwd = ROOT, env, shell = false, onLine, onStderr, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, out: '', err: String(e), spawnError: String(e), timedOut: false });
    }
    let out = '', err = '', buf = '', timedOut = false;

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
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && buf.trim()) onLine(buf);
      resolve({ code: timedOut ? 124 : (code ?? 0), out, err, timedOut });
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
    const r = await runProcess(cmd, [], { shell: true, cwd, timeoutMs });
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
