/** Llamada al autor (implementador) con el work order + mapa del scout. */
import path from 'node:path';
import { readAgent } from './agents.mjs';
import { workOrderText, modelCallOpts } from './pure.mjs';
import { callModel } from './runner.mjs';

export async function callAuthor(ctx, task, cycleDir, model, key, scoutMap, extra = '') {
  return callModel({
    runner: ctx.runner, pi: ctx.pi, ...modelCallOpts(ctx.config, model), apiKey: key?.value,
    systemPrompt: readAgent('author'),
    prompt: workOrderText(task, { workdir: ctx.workdir, scoutMap }) + extra,
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
    // loop.authorThinking (off|minimal|low|medium|high|xhigh): nivel de razonamiento del autor. Sin él pi usa el
    // predeterminado del modelo, y con modelos que razonan mucho el autor puede agotar el tiempo antes de actuar.
    thinking: ctx.config?.loop?.authorThinking || undefined,
    logFile: path.join(cycleDir, 'author.json'), cwd: ctx.workdir, role: 'author',
  });
}
