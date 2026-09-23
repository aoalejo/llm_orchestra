/** Ejecución de procesos y llamadas a pi (real o stub). */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { ROOT } from './paths.mjs';
import { exists, now } from './util.mjs';
import { log } from './log.mjs';
import { detectExhausted } from './pure.mjs';
import { stubModel } from './stub.mjs';

export function resolvePi(config) {
  const candidates = [process.env.ORCHESTRA_PI_CLI, config.piCli].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) return { command: process.execPath, prefix: [c], shell: false, label: c };
  }
  const cmd = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  return { command: cmd, prefix: [], shell: true, label: cmd };
}

export function runProcess(command, args, { cwd = ROOT, env, shell = false, onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, out: '', err: String(e), spawnError: String(e) });
    }
    let out = '', err = '', buf = '';
    const timer = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs) : null;
    child.stdout.on('data', (d) => {
      const s = d.toString(); out += s;
      if (onLine) { buf += s; const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ''; for (const l of lines) onLine(l); }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && buf.trim()) onLine(buf);
      resolve({ code: code ?? 0, out, err });
    });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: 1, out, err, spawnError: e.message }); });
  });
}

export async function runPi(ctx) {
  const { pi, provider, model, apiKey, systemPrompt, prompt, tools, thinking, logFile } = ctx;
  const args = ['--mode', 'json', '-p', '--no-session', '--provider', provider];
  if (model) args.push('--model', model);
  if (apiKey) args.push('--api-key', apiKey);
  if (thinking) args.push('--thinking', thinking);
  if (tools && tools.length) args.push('--tools', tools.join(','));
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  args.push(prompt);

  const events = [];
  const res = await runProcess(pi.command, [...pi.prefix, ...args], {
    shell: pi.shell,
    cwd: ctx.cwd || ROOT,
    onLine: (line) => { if (!line.trim()) return; try { events.push(JSON.parse(line)); } catch { /* noop */ } },
  });

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
  if (logFile) {
    const safeArgs = args.map((a, i) => (args[i - 1] === '--api-key' ? '***' : a));
    fs.writeFileSync(logFile, JSON.stringify({ model, code: res.code, usage, stopReason, errorMessage, stderr: res.err, text, args: safeArgs }, null, 2));
  }
  return { code: res.code, text, usage, stopReason, errorMessage, stderr: res.err, spawnError: res.spawnError, exhausted: detectExhausted({ stderr: res.err, errorMessage }), modelUsed };
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
