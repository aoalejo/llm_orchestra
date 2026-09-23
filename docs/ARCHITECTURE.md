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

- `pickKey(role)`: orquestador siempre cuenta A; workers usan el pool B (una o varias keys)
  con round-robin y set de `exhausted`. Las keys se leen de `config.keys.workers`: una **sola
  env var** con lista (`OPENCODE_GO_KEYS`, acepta `k1,k2`, saltos de línea o JSON) o, legacy,
  un array de env vars. Cada key se identifica como `<envVar>#<idx>` en el ledger.
- Detección de agotamiento: regex sobre stderr/errores (`401/402/429/quota/insufficient/...`).
- Al quedarse sin keys B: `callOrchestrator` decide (`useOrchestratorKey|useFallbackModels|pause`).
- `--keys-status` muestra las cuentas enmascaradas.
- `--keys-check` hace una llamada real mínima por key (modelo barato) y dice
  cuál responde, cuál está agotada (saldo/límite) y cuánto costó cada una. Útil
  con varias cuentas rotando: el loop detecta la cuenta muerta recién al usarla
  (quema un ciclo), este chequeo lo adelanta.

## 7. Artefactos

```
.orchestra/
  runs/<task>/state.json                 # resume
  runs/<task>/cycle-N/author.json        # salida + usage del autor
  runs/<task>/cycle-N/gate.log           # gate determinista
  runs/<task>/cycle-N/diff.patch         # diff del ciclo
  runs/<task>/cycle-N/<rol>.json         # salida + usage (se escribe SIEMPRE, también en timeout)
  runs/<task>/cycle-N/<rol>.stream.jsonl # stream en vivo de pi (evento por línea)
  runs/<task>/cycle-N/<rol>.stderr.log   # stderr crudo de pi
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

`node orchestra.mjs --self-test` valida lógica pura sin red (hoy **72 casos**):
`extractLastJson`, `findingsSignature`, `isProtected`, `isProtectedChange`, `gateCommands`,
`workOrderText`, `pickAuthorVerifier`, `pickFallbackPair`, `recordUsage`,
`budgetStatus`, `shouldMetaReview`, `stubModel`, `pathsConflict`, `parseArgs`,
`matchModel`, `rankModels`, `configPatchFromRanking`, `idVariants`, `bestArenaMatch`,
`summarizeLedger`, `resolveLinkTargets`, `detectExhausted`, `parseKeyList`,
`workerKeyEntries`, `maxAgeHoursOf`, `rankingsStale`, `streamPathFor`, `heartbeatPathFor`,
`runProcess` (timeout).
**Si agregás lógica pura, agregá su caso.** El self-test ya cazó bugs reales
(`extractLastJson` tomaba objetos anidados).

Además, `--stub` (`ORCHESTRA_RUNNER=stub`) corre el loop completo con `stubModel`,
salteando gates y diff reales: sirve para validar el pipeline sin red ni keys en CI.

### tests/smoke.mjs (integración)

`node tests/smoke.mjs` crea un repo git temporal, hace `init` y corre el ciclo completo con
`--stub` + `ORCHESTRA_STUB_TOUCH=1` (el author stub deja un cambio real en el worktree),
y verifica **20 invariantes**: dry-run no muta el backlog, ruta protegida sin/con `--yes`,
commit + merge reales, paralelismo (`--all --workers 2`), limpieza de worktrees y ramas,
ledger, `report --json`.

CI (`.github/workflows/ci.yml`) corre self-test + smoke en ubuntu/windows × node 20/22.
`npm test` corre ambos.

## 9. Extensión `/orchestra`

`extensions/orchestra.ts` registra el comando `/orchestra` que invoca el driver con
`process.execPath` y `stdio: inherit`. Los args se pasan tal cual (`init`, `--plan`, …).

## 10. Ranking de modelos (`lib/`)

`orchestra models` determina periódicamente los mejores modelos **baratos** para la
rotación, en vez de hardcodear nombres en `config.json`:

1. **Catálogo vivo**: `GET {baseUrl}/models` de `opencode-go` (`lib/models.mjs`), usando la
   key de A/B o `~/.pi/agent/auth.json`.
2. **Costos**: `~/.pi/agent/models-store.json` (fuente local autoritativa); se unen ambos y
   se marcan los modelos que sólo están en el endpoint (sin costo cacheado).
3. **Score**: se scrapea `arena.ai/leaderboard/code/webdev` (`lib/leaderboard.mjs`, portado
   de `aoalejo/opencode_mcp`). Cuatro fuentes, en orden de confianza (campo `source`):
   - `arena` — el id matchea directo un slug del leaderboard.
   - `alias` — el id figura en arena con otro slug (`models.aliases`).
     Ej: `qwen3.8-flash` se publica como `qwen3.8-flash-next` (#9, 1636).
   - `suffix` — se le quitan al id sufijos no semánticos (`-contributor`, `-exp`,
     `-instruct`, …) y así matchea. Ej: `muse-spark-1.3-contributor` → `muse-spark-1.3 (xHigh)`.
   - `override` — score fijado a mano en `models.scoreOverrides` para un SKU nuevo que arena
     aún no rankea. Ej: `mimo-v2.6-flash` ≈ `deepseek-v4.1-flash`.
   - `family` — último recurso: hereda el score del hermano de **costo más parecido** de la
     misma familia × 0.95, y queda marcado `inferred` (se avisa por warn para verificarlo).
4. **Pools** (`lib/rank.mjs`): `author`/`verifier` = mejores baratos (`workerMaxInputCost`);
   `verifier` rota la lista del `author` para nunca coincidir en el mismo índice; `fallback` =
   siguientes baratos; `escalation*` = top de score.
   Dentro de `scoreTolerancePct` (1%) gana el **más barato**: 0.5% de ventaja no justifica 5x de precio.

```bash
orchestra models            # muestra el ranking, no escribe nada
orchestra models --apply    # escribe roles/fallback en config.json (backup .bak)
orchestra models --json     # salida máquina
```

Si `models.rankings.autoApply` es `true` (default), en cada corrida real se refresca si el
archivo `.orchestra/models.generated.json` supera `models.rankings.maxAgeHours` (default **24 h**)
y se aplican los pools solos, con backup en `config.json.bak`. Ponelo en `false` para revisar antes.

**Pins y overrides** (el refresh no los pisa):
- `models.pins.<rol>`: fuerza un modelo en `author`/`verifier` (listas) y
  `escalationAuthor`/`escalationVerifier`/`service`/`scout`/`scribe`/`security`/`merge` (strings).
- `models.exclude`: blocklist de ids que nunca se usan.
- `models.scoreOverrides`: score manual por id (SKUs nuevos sin entrada en arena).
- `models.aliases`: id de opencode-go → slug(s) de arena.

## 11. Report y señales

- `orchestra report [--json]` agrega `.orchestra/ledger.jsonl`: costo total, llamadas y costo
  por **rol**, por **modelo** y por **tarea**, más gates rojos, keys agotadas y el estado de
  cada corrida (`runs/<task>/state.json`). Es la versión CLI del "dashboard" del roadmap.
- **Timeout de pi**: cada llamada a `pi` tiene `loop.piTimeoutMs` (default 15 min). Al vencer
  se mata el **árbol** del proceso (en Windows `taskkill /PID /T /F`, para no dejar el `node.exe`
  huérfano), se marca `timedOut: true` y el ciclo lo trata como **fallo reintentable**. El
  `logFile` se escribe igual (antes se perdía la evidencia).
- **Streaming a disco**: `runPi` appendea cada línea del stream a `<rol>.stream.jsonl` y el
  stderr a `<rol>.stderr.log`, así un run colgado es inspeccionable en tiempo real.
- **Heartbeat**: `runs/<task>/heartbeat.json` con `{ts, pid, role, model, silentMs, timeoutMs}`
  (se escribe al iniciar y cada 30 s) para que un watchdog externo detecte cuelgues. Con
  `--verbose` además loguea "sin datos desde Xs (último: <evento>)".
- **`orchestra --clean [--force]`**: deslinkea los junctions de dependencias **antes** de
  borrar, y limpia worktrees/ramas huérfanas. Conserva los de tareas `approved` (salvo
  `--force`). Es la limpieza segura tras un `SIGKILL`, que antes podía dejar que un
  `git worktree remove` atravesara el junction y borrara el `node_modules` real.
- **Señales**: `SIGINT`/`SIGTERM` eliminan los worktrees que quedaron a medio hacer.

## 12. Layout de módulos (`lib/`)

`orchestra.mjs` es sólo el entrypoint/CLI (`init`, `models`, `report`, `selfTest`, `main`).
La lógica vive en módulos chicos:

| Módulo | Qué contiene |
|---|---|
| `paths.mjs` | `ROOT`, `.orchestra/`, `RUNS`, `SCRATCH`, `WORKTREES`, `LEDGER`, `AGENTS_DIR`. |
| `log.mjs` | `log`/`vlog`/`warn`/`die` + flags `verbose`/`quiet`. |
| `util.mjs` | fs/JSON, `makeQueue` (colas FIFO), `runWithConcurrency`. |
| `agents.mjs` | `readAgent` (prompts de rol) y `loadEnv`. |
| `args.mjs` | `parseArgs`. |
| `pure.mjs` | Lógica pura testeable (JSON, findings, paths, work order, presupuesto, stall…). |
| `stub.mjs` | `stubModel` (runner sin red). |
| `runner.mjs` | `resolvePi`, `runProcess`, `runPi`, `callModel`, `runGate`, `writeDiff`, `changedFiles`. |
| `worktrees.mjs` | `prepareWorktree`/`removeWorktree`, enlace de deps, señales. |
| `keys.mjs` | Pool A/B: `makeKeyState`, `pickKey`, `keysStatus`. |
| `loop.mjs` | `callOrchestrator/Scout/Verifier`, `runTaskLoop`, `integrateTask`. |
| `report.mjs` | `readLedger`, `summarizeLedger`, `reportCommand`. |
| `modelscmd.mjs` | `runModelsCommand`, `applyAndSaveRanking`. |
| `models/rank/leaderboard.mjs` | Ranking de modelos (catálogo, pools, arena.ai). |

## 13. Cómo extender

- **Nuevo rol**: crear `agents/<rol>.md` + `roles.<rol>` en config + usarlo en el loop.
- **Nueva estrategia de integración**: hoy sólo `merge-branch`; `integration.strategy` está listo para `patch-apply` u otras.
- **Nuevos gates**: agregar claves en `gates` y referenciarlas en `task.targets`.
- **Nuevo proveedor** (no opencode): cambiar `provider` y `provider`/`apiKey` en `runPi`; hoy asume flags de pi (`--provider`, `--api-key`).
