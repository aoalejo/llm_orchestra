/** Llamada al autor (implementador) con el work order + mapa del scout. */
import path from 'node:path';
import { readAgent } from './agents.mjs';
import { workOrderText } from './pure.mjs';
import { callModel } from './runner.mjs';

export async function callAuthor(ctx, task, cycleDir, model, key, scoutMap) {
  return callModel({
    runner: ctx.runner, pi: ctx.pi, provider: ctx.config.provider, model, apiKey: key?.value,
    systemPrompt: readAgent('author'),
    prompt: workOrderText(task, { workdir: ctx.workdir, scoutMap }),
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
    logFile: path.join(cycleDir, 'author.json'), cwd: ctx.workdir, role: 'author',
  });
}
