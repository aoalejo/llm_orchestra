# Arquitectura — Lean Orchestrator v2

Detalle interno de `orchestra.mjs`. Sin dependencias externas (Node ≥ 20).

## 1. Modelo mental

El orquestador **no mantiene el contexto de todo el trabajo**. El estado vive en
archivos (`.orchestra/`), y cada subagente arranca con **contexto fresco** recibiendo
un *work order* acotado. Esto evita "context rot" y permite ciclar modelos baratos.

## 2. Roles

| Rol | System prompt | Tools | Cuenta |
|---|---|---|---|
| `orchestrator` | `agents/orchestrator.md` | read, grep, find, ls, bash | A |
| `scout` | `agents/scout.md` | read, grep, find, ls, bash | B |
| `author` | `agents/author.md` | + edit, write | B |
| `verifier` | `agents/verifier.md` | read, grep, find, ls, bash | B |
| `security-reviewer` | `agents/security-reviewer.md` | read, grep, find, ls, bash | B |
| `merge-agent` | `agents/merge-agent.md` | + edit, write | B |
| `scribe` | `agents/scribe.md` | + edit, write | B |

Los agentes se resuelven así: `.pi/agents/` del proyecto → si no existe, `agents/` del paquete.
Override total con `ORCHESTRA_AGENTS_DIR`.

## 3. Config (`config.json`)

```jsonc
{
  "provider": "opencode-go",
  "keys": { "orchestrator": "ENV_A", "workers": ["ENV_B1", "ENV_B2"] },
  "roles": { "orchestrator": {...}, "author": [...], "verifier": [...], ... },
  "fallback": { "models": [...], "askOrchestratorOnExhaustion": true },
  "loop": { "maxCycles": 4, "maxParallelTasks": 4, "doubleVerifyHighRisk": true, "highRiskLevels": ["high","critical"] },
  "worktrees": { "enabled": true, "dir": ".orchestra/worktrees", "linkNodeModules": true },
  "integration": { "strategy": "merge-branch", "branchPrefix": "orchestra/", "mergeAgent": true },
  "scout": { "enabled": true },
  "metaReview": { "enabled": true, "sampleRate": 0.34, "alwaysForHighRisk": true },
  "progress": { "repeatSignatureLimit": 2 },
  "budget": { "maxUsdPerTask": 2.0, ... },
  "gates": { "backend": [ "cmd", ... ], "mobile": [...], ... },
  "protectedPaths": ["..."],
  "commit": { "onlyOrchestrator": true, "requireFlag": "--commit", "requireHumanApprovalForProtected": true }
}
```

## 4. Loop por tarea

1. **Resume**: si `runs/<task>/state.json` existe y está `approved`, salta; si está `in-progress`, continúa del ciclo guardado.
2. **Scout** (una vez): comprime el mapa de contexto; se guarda en `state.scoutMap`.
3. **Ciclo 1..maxCycles**:
   a. Elegir `{author, verifier}` con `pickAuthorVerifier` — rotan por ciclo y el verifier **nunca** es el author; el último ciclo usa los modelos de escalado.
   b. **Author**: corre con `workOrderText(task)` + mapa del scout. Suma costo.
   c. **Presupuesto**: si supera `budget.maxUsdPerTask`, `maxInputTokensPerTask` o `maxOutputTokensPerTask`, marca `blocked` y sale. Se chequea tras el autor y tras la verificación.
   d. **Gate determinista**: corre todos los comandos del `targets` (o todos si no hay). Si rojo → siguiente ciclo (sin gastar verifier LLM).
   e. **Verify**: `git diff` → verifier adversario. Si `risk` alto y `doubleVerifyHighRisk`: 2º verifier + security-reviewer.
   f. **Anti-loop**: firma de findings (`file:line:problem`, sorted). Si se repite `repeatSignatureLimit` veces → pregunta al orquestador (`escalateModel|park|continue`). `escalateModel` fija `state.forcedAuthor` (o usa `kimi-k2.7-code`).
   g. **Meta-review**: con probabilidad `sampleRate` (o siempre en alto riesgo) el orquestador audita el PASS (`CONFIRM|OVERTURN`).
   h. **Aprobación final**: el orquestador responde `{decision, commitMessage, reason}`. `APPROVE` → estado `approved`.
4. Sin aprobar tras N ciclos → `failed` (escalar a humano).

## 5. Worktrees e integración

- `prepareWorktree`: `git worktree add -b orchestra/<id> <dir> HEAD`; enlaza `node_modules` por junction/symlink.
- El author/verifier trabajan con `cwd = worktree`.
- Al aprobar **y** con `--commit` (y no `--dry-run`):
  - Chequeo **estricto** de rutas protegidas sobre los archivos que el diff realmente tocó (`git diff --name-only`), no solo el `scope` declarado.
  - `integrateTask`: `git add -A && git commit` **en el worktree** (commit en nombre del orquestador) y luego `git merge --no-ff` a la rama base.
  - El merge está **serializado por una cola** (`makeQueue`) porque toca `ROOT`: evita carreras entre tareas paralelas. El `scribe` y la escritura de `tasks.json` usan otra cola y releen el archivo fresco antes de escribir.
  - Tras integrar, el worktree y su rama `orchestra/<id>` se limpian.
- Al aprobar sin integrar (dry-run, sin `--commit`, o ruta protegida sin `--yes`), el worktree se **conserva** y **no** se marca `done` en `tasks.json` (reintentá con `--commit`).
- Paralelismo: `runWithConcurrency` con límite `--workers` o `loop.maxParallelTasks` (máx 4 sugerido).

## 6. Keys y rotación

- `pickKey(role)`: orquestador siempre cuenta A; workers usan el pool B con round-robin y set de `exhausted`.
- Detección de agotamiento: regex sobre stderr/errores (`401/402/429/quota/insufficient/...`).
- Al quedarse sin keys B: `callOrchestrator` decide (`useOrchestratorKey|useFallbackModels|pause`).
- `--keys-status` muestra las cuentas enmascaradas.

## 7. Artefactos

```
.orchestra/
  runs/<task>/state.json                 # resume
  runs/<task>/cycle-N/author.json        # salida + usage del autor
  runs/<task>/cycle-N/gate.log           # gate determinista
  runs/<task>/cycle-N/diff.patch         # diff del ciclo
  runs/<task>/cycle-N/verdict-*.json     # verdicts
  runs/<task>/cycle-N/approval.json      # aprobación del orquestador
  runs/<task>/cycle-N/{scout,merge-agent,meta-review}.json
  runs/<task>/merge-agent.json
  runs/last-run.json                     # resumen de la corrida
  ledger.jsonl                           # por ciclo: modelo, key, costo, veredicto
  scratch/                               # counter-tests del verifier
  worktrees/<task>/                      # worktrees
```

## 8. Self-test

`node orchestra.mjs --self-test` valida lógica pura sin red (hoy **27 casos**):
`extractLastJson`, `findingsSignature`, `isProtected`, `isProtectedChange`, `gateCommands`,
`workOrderText`, `pickAuthorVerifier`, `pickFallbackPair`, `recordUsage`,
`budgetStatus`, `shouldMetaReview`, `stubModel`, `pathsConflict`, `parseArgs`.
**Si agregás lógica pura, agregá su caso.** El self-test ya cazó bugs reales
(`extractLastJson` tomaba objetos anidados).

Además, `--stub` (`ORCHESTRA_RUNNER=stub`) corre el loop completo con `stubModel`,
salteando gates y diff reales: sirve para validar el pipeline sin red ni keys en CI.

## 9. Extensión `/orchestra`

`extensions/orchestra.ts` registra el comando `/orchestra` que invoca el driver con
`process.execPath` y `stdio: inherit`. Los args se pasan tal cual (`init`, `--plan`, …).

## 10. Cómo extender

- **Nuevo rol**: crear `agents/<rol>.md` + `roles.<rol>` en config + usarlo en el loop.
- **Nueva estrategia de integración**: hoy sólo `merge-branch`; `integration.strategy` está listo para `patch-apply` u otras.
- **Nuevos gates**: agregar claves en `gates` y referenciarlas en `task.targets`.
- **Nuevo proveedor** (no opencode): cambiar `provider` y `provider`/`apiKey` en `runPi`; hoy asume flags de pi (`--provider`, `--api-key`).
