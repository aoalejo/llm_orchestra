/** Verificación adversaria: llamada al verifier/security-reviewer. */
import path from "node:path";
import { SCRATCH } from "./paths.mjs";
import { extractLastJson, workOrderText } from "./pure.mjs";
import { readAgent } from "./agents.mjs";
import { pickKey } from "./keys.mjs";
import { callModel } from "./runner.mjs";

export async function callVerifier(ctx, task, model, agentName, suffix, cycleDir) {
  const key = pickKey(ctx.config, ctx.keyState, 'worker');
  const out = await callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model, apiKey: key?.value,
    systemPrompt: readAgent(agentName),
    prompt: `WORK ORDER:\n${workOrderText(task, { workdir: ctx.workdir })}\n\nDIFF: ${path.join(cycleDir, 'diff.patch')}\nGate log: ${path.join(cycleDir, 'gate.log')}\nZona de counter-tests (absoluta): ${SCRATCH}\n\nDevolvé el verdict JSON.`,
    tools: ['read', 'grep', 'find', 'ls', 'bash'], logFile: path.join(cycleDir, `verdict-${suffix}.json`), cwd: ctx.workdir, role: agentName,
  });
  if (out.exhausted && key) ctx.keyState.exhausted.add(key.name);
  return { verdict: extractLastJson(out.text), out, key };
}
