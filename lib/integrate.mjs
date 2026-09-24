/** Integración: commit en el worktree + merge (con merge-agent si hay conflicto). */
import path from "node:path";
import { ROOT, RUNS, LEDGER } from "./paths.mjs";
import { appendJsonl, now } from "./util.mjs";
import { warn } from "./log.mjs";
import { readAgent } from "./agents.mjs";
import { pickKey } from "./keys.mjs";
import { callModel, runProcess } from "./runner.mjs";

export async function integrateTask(ctx, task, wt, commitMessage) {
  if (!wt.ephemeral) return { ok: true, skipped: true };
  // Serializado: el merge toca ROOT y no debe solaparse entre tareas paralelas.
  return ctx.queues.git(async () => {
    // Commit en el worktree (en nombre del orquestador)
    await runProcess('git', ['add', '-A'], { cwd: wt.dir });
    const c = await runProcess('git', ['commit', '-m', commitMessage], { cwd: wt.dir });
    if (c.code !== 0 && !/nothing to commit/i.test(c.out + c.err)) return { ok: false, log: c.out + c.err };
    // Merge a la rama base
    const m = await runProcess('git', ['merge', '--no-ff', '--no-edit', wt.branch], { cwd: ROOT });
    if (m.code === 0) return { ok: true, log: m.out };
    // Merge agent
    if (ctx.config.integration?.mergeAgent) {
      warn(`conflicto al integrar ${task.id}; invocando merge-agent`);
      const key = pickKey(ctx.config, ctx.keyState, 'worker');
      const fix = await callModel({
        runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model: ctx.config.roles.merge, apiKey: key?.value,
        systemPrompt: readAgent('merge-agent'),
        prompt: `Resolvé los conflictos de merge en ${ROOT} para integrar ${wt.branch}.\nEvento de merge:\n${(m.out + m.err).slice(0, 4000)}`,
        tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'], logFile: path.join(RUNS, task.id, 'merge-agent.json'), cwd: ROOT, role: 'merge-agent',
      });
      if (fix.exhausted && key) ctx.keyState.exhausted.add(key.name);
      appendJsonl(LEDGER, { ts: now(), task: task.id, cycle: null, role: 'merge-agent', model: ctx.config.roles.merge, key: key?.name ?? null, cost: fix.usage?.cost || 0, turns: fix.usage?.turns || 0, exhausted: !!fix.exhausted, timedOut: !!fix.timedOut });
      await runProcess('git', ['add', '-A'], { cwd: ROOT });
      const mc = await runProcess('git', ['commit', '--no-edit'], { cwd: ROOT });
      if (mc.code === 0) return { ok: true, log: 'resuelto por merge-agent' };
    }
    await runProcess('git', ['merge', '--abort'], { cwd: ROOT });
    return { ok: false, conflict: true, log: m.out + m.err };
  });
}
