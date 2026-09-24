# Arquitectura — Lean Orchestrator v2

Detalle interno de `orchestra.mjs`. Sin dependencias externas (Node ≥ 20).

## 1. Modelo mental

El orquestador **no mantiene el contexto de todo el trabajo**. El estado vive en
archivos (`.orchestra/`), y cada subagente arranca con **contexto fresco** recibiendo
un *work order* acotado. Esto evita "context rot" y permite ciclar modelos baratos.

## 2. Roles

| Rol | System prompt | Tools | Cuenta |
|---|---|---|---|
| `scout` | `agents/scout.md` | read, grep, find, ls, bash | B |
| `author` | `agents/author.md` | + edit, write | B |
| `verifier` | `agents/verifier.md` | read, grep, find, ls, bash | B |
| `security-reviewer` | `agents/security-reviewer.md` | read, grep, find, ls, bash | B |
| `merge-agent` | `agents/merge-agent.md` | + edit, write | B |
| `scribe` | `agents/scribe.md` | + edit, write | B |

No hay un rol `orchestrator` interno: **el orquestador es el chat** que invoca al driver
(modo chat). `roles.orchestrator` en config sólo se usa para `--keys-check` (probar la cuenta A).

Los agentes se resuelven así: `.pi/agents/` del proyecto → si no existe, `agents/` del paquete.
Override total con `ORCHESTRA_AGENTS_DIR`.

## 3. Config (`config.json`)

```jsonc
{
  "provider": "opencode-go",
  "keys": { "orchestrator": "ENV_A", "workers": "OPENCODE_GO_KEYS" },
  "roles": { "author": [...], "verifier": [...], ... },
  "fallback": { "models": [...], "askOrchestratorOnExhaustion": true },
  "loop": { "maxCycles": 4, "maxParallelTasks": 4, "doubleVerifyHighRisk": true, "highRiskLevels": ["high","critical"], "autoEscalate": false },
  "worktrees": { "enabled": true, "dir": ".orchestra/worktrees", "linkNodeModules": true },
  "integration": { "strategy": "merge-branch", "branchPrefix": "orchestra/", "mergeAgent": true },
  "scout": { "enabled": true },
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
   a. Elegir `{author, verifier}` con `pickAuthorVerifier` — rotan por ciclo y el verifier **nunca** es el author; el último ciclo usa el par de escalado solo si loop.autoEscalate=true (ADR 0005); por defecto sigue rotando baratos.
   b. **Author**: corre con `workOrderText(task)` + mapa del scout. Suma costo.
   c. **Presupuesto**: si supera `budget.maxUsdPerTask`, `maxInputTokensPerTask` o `maxOutputTokensPerTask`, marca `blocked` y sale. Se chequea tras el autor y tras la verificación.
   d. **Gate determinista**: corre todos los comandos del `targets` (o todos si no hay). Si rojo → siguiente ciclo (sin gastar verifier LLM).
   e. **Verify**: `git diff` → verifier adversario. Si `risk` alto y `doubleVerifyHighRisk`: 2º verifier + security-reviewer.
   f. **Anti-loop**: firma de findings (`file:line:problem`, sorted). Si se repite `repeatSignatureLimit` veces → devuelve `needs-decision` (`options: escalate|park|continue`) al chat. Con `--decisions '{"stall":"escalate"}'` se aplica y sigue.
   g. **Cuota**: si no hay key de worker → `needs-decision` (`options: use_orchestrator|use_fallback_models|pause`) con el costo acumulado, para que el chat decida. La cuenta A es **última instancia**.
   h. **Aprobación (modo chat)**: sin `--commit` el loop termina en `needs-approval` y devuelve el **resultado compacto** (verdict, findings, costo, diff); el chat aprueba con `orchestra approve`. Con `--commit`/`--yes` se auto-aprueba e integra.
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

`node orchestra.mjs --self-test` valida lógica pura sin red (hoy **91 casos**):
`extractLastJson`, `findingsSignature`, `isProtected`, `isProtectedChange`, `gateCommands`,
`workOrderText`, `pickAuthorVerifier`, `pickFallbackPair`, `recordUsage`,
`budgetStatus`, `shouldMetaReview`, `stubModel`, `pathsConflict`, `parseArgs`,
`matchModel`, `rankModels`, `configPatchFromRanking`, `idVariants`, `bestArenaMatch`,
`summarizeLedger`, `resolveLinkTargets`, `detectExhausted`, `parseKeyList`,
`workerKeyEntries`, `maxAgeHoursOf`, `rankingsStale`, `streamPathFor`, `heartbeatPathFor`,
`runProcess` (timeout), `normalizeWorkOrder`, `validateWorkOrder`, `compactFindings`, `slugify`, `scoutCacheKey`, `socraticodeOptions`, `buildScoutPrompt`, `parseUsage`, `quotaStatus`, `estimateRemaining`, `renderDashboard`, `renderDashboardPlain`.
**Si agregás lógica pura, agregá su caso.** El self-test ya cazó bugs reales
(`extractLastJson` tomaba objetos anidados).

Además, `--stub` (`ORCHESTRA_RUNNER=stub`) corre el loop completo con `stubModel`,
salteando gates y diff reales: sirve para validar el pipeline sin red ni keys en CI.

### tests/smoke.mjs (integración)

`node tests/smoke.mjs` crea un repo git temporal, hace `init` y corre el ciclo completo con
`--stub` + `ORCHESTRA_STUB_TOUCH=1` (el author stub deja un cambio real en el worktree),
y verifica **36 invariantes**: dry-run no muta el backlog, ruta protegida sin/con `--yes`,
commit + merge reales, paralelismo (`--all --workers 2`), modo chat (`scout`/`dispatch`/
`approve`/`status` y multi-orden), limpieza de worktrees y ramas, ledger, `report --json`.

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

`orchestra.mjs` es sólo el entrypoint/CLI (`init`, `models`, `report`, `main`).
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
| `loop.mjs` | `callScout`/`callVerifier`, `runTaskLoop` (modo chat: `needs-approval`/`needs-decision`), `integrateTask`. |
| `author.mjs` / `verify.mjs` / `integrate.mjs` | Autor, verificación adversaria e integración (extraídos de `loop`). |
| `selftest.mjs` | Self-test de lógica pura (fuera del entrypoint). |
| `commands.mjs` | Subcomandos de chat: `scoutCommand`, `dispatchCommand`, `approveCommand`, `rejectCommand`, `statusCommand`, `executeTask`. |
| `report.mjs` | `readLedger`, `summarizeLedger`, `reportCommand`. |
| `modelscmd.mjs` | `runModelsCommand`, `applyAndSaveRanking`. |
| `models/rank/leaderboard.mjs` | Ranking de modelos (catálogo, pools, arena.ai). |

## 13. Cómo extender

- **Nuevo rol**: crear `agents/<rol>.md` + `roles.<rol>` en config + usarlo en el loop.
- **Nueva estrategia de integración**: hoy sólo `merge-branch`; `integration.strategy` está listo para `patch-apply` u otras.
- **Nuevos gates**: agregar claves en `gates` y referenciarlas en `task.targets`.
- **Nuevo proveedor** (no opencode): cambiar `provider` y `provider`/`apiKey` en `runPi`; hoy asume flags de pi (`--provider`, `--api-key`).

## 14. Modo chat (el orquestador sos vos)

No hay LLM de management. El chat decide y aprueba vía subcomandos (`lib/commands.mjs`)
y **tools de pi** (`extensions/orchestra.ts`) equivalentes:

| Tool de pi | Comando | Qué hace | Devuelve |
|---|---|---|---|
| `orchestra_scout` | `scout` | recon read-only con modelo barato | mapa comprimido + costo |
| `orchestra_dispatch` | `dispatch` | 1..N work orders en paralelo (worktrees) | array de resultados compactos |
| `orchestra_approve` | `approve` | aprueba y (si `commit`) integra | resultado + integración |
| `orchestra_reject` | `reject` | descarta y limpia el worktree | `{status:rejected}` |
| `orchestra_status` | `status` | estado de tareas y decisiones | lista compacta |
| `orchestra_usage` | `usage` | cuota consumida por cuenta | percentages |
| `orchestra_dashboard` | `dashboard` | costos/tareas/cuota/worktrees | líneas |
| `orchestra_models` | `models` | ranking/rotación (opcional `apply`) | pools |
| `orchestra_report` | `report` | costo/uso del ledger | resumen |

Las tools corren el driver con `--json` y devuelven el JSON compacto al modelo (nunca
transcripts). `dispatch` bloquea hasta terminar.

Un **work order** es `{ id?, goal, acceptance[], scope[], targets[], risk }`. Se normaliza con
`normalizeWorkOrder` y se valida con `validateWorkOrder` (sin `acceptance` no hay verificación):
el chat manda la intención y, si quiere, las restricciones; el driver lo persiste en `tasks.json`
(reanudable). El **resultado compacto** incluye `status`, `verdict`, `findings` (medium+), `cost`,
`diff` y `workdir` — nunca transcripts completos.

Estados que el driver devuelve al chat cuando necesita una decisión:
- `needs-approval`: todo verde; llamá `approve` o `reject`.
- `needs-decision` (keys-exhausted): `options: use_orchestrator | use_fallback_models | pause`.
- `needs-decision` (stalled): `options: escalate | park | continue`.
Reintentá con `--decisions '{"keys":"..."}'` o `'{"stall":"..."}'`.

## 15. Scout, cuota y costo

### Scout (proveedor + cache)
`orchestra scout` (o `orchestra_scout`) devuelve un mapa comprimido. Provider configurable
(`scout.provider`):
- `llm`: un modelo worker sintetiza el mapa.
- `socraticode`: consulta un server **MCP externo** (SocratiCode) vía `lib/mcp.mjs`
  (cliente stdio mínimo, sin dependencias) + `lib/scout.mjs`. Si el proyecto está indexado,
  usa `codebase_search` como contexto (o directo si `synthesize:false`); si no, fallback a LLM.
- `auto` (default): socraticode si está disponible; si no, LLM.

Cache en `.orchestra/runs/scout/cache/` keyed por `git HEAD + query + scope + projectPath`
(`scout.cache.maxAgeMinutes`, default 720). Flags: `--provider`, `--no-cache`, `--index`.
Config: `scout.socraticode.{command,args,env,projectPath,limit,minScore,autoIndex,synthesize,timeoutMs}`.
El compose de SocratiCode ya usa Qdrant `:16333` y Ollama `:11435`, que son sus defaults.

### Cuota
`GET {baseUrl}/usage` devuelve el % consumido por ventana (rolling/weekly/monthly) por cuenta.
`orchestra usage [--json]` (tool `orchestra_usage`) lo muestra; `lib/usage.mjs` lo consulta
con cache de 60 s.

### Costo
`lib/cost.mjs` estima el costo restante desde el ledger (`avgPerTask` o `avgPerCycle × maxCycles`).
Cuando B se agota, `needs-decision` incluye `estimatedRemainingUsd`, `estimate` y
`orchestratorQuota`, para que el chat decida: cerrar con la cuenta A, usar `fallback.models`
o parar. La cuenta A es **última instancia**.

## 16. Dashboard

`lib/dashboard.mjs` + `orchestra dashboard [--interval 2] [--once] [--plain] [--json] [--no-usage]`:
- **Fase 1 (TUI)**: frame ANSI full-screen redibujado cada `--interval` s; `--once`/no-TTY/`--json`
  sacan una sola imagen. Muestra costo por rol/modelo, tareas y su estado
  (`needs-approval`/`needs-decision`), cuota por cuenta, worktrees/ramas y estado del ranking.
- **Fase 2 (panel dentro de pi)**: la extensión llama a `dashboard --once --plain --no-usage` cada
  2.5 s mientras corre `orchestra_dispatch` y lo pinta con `ctx.ui.setWidget` + `onUpdate`
  (progreso en vivo durante una orden larga). `/orchestra-dashboard` deja un widget persistente
  (cada 5 s) y `/orchestra-dashboard-off` lo oculta. Tool: `orchestra_dashboard`.

Los renderers (`renderDashboard`, `renderDashboardPlain`) son puros y reciben el objeto de
`gatherDashboard` (ledger + state.json + `/usage` + git).

## 17. Guardarraíles de subagentes (egress / contención)

`lib/guards.mjs` define `denyRead` (globs) y `denyCommands` (regex) con defaults
(`.orchestra/.env*`, `**/.env`, `**/*.pem`, `**/.ssh/**`, `taskkill`, `docker compose`,
`systemctl restart`, `run_proto`, ...). El driver los exporta por env (`ORCHESTRA_GUARDS`)
y pasa `ORCHESTRA_ROLE`/`ORCHESTRA_LOG` a cada `pi` headless; la extensión los aplica en
`pi.on("tool_call")`: bloquea la lectura de rutas denegadas y comandos peligrosos, y
loguea cada comando en `<rol>.commands.log`. Sólo actúa cuando existe `ORCHESTRA_ROLE`
(no toca tu sesión interactiva).

Para datos sensibles: `verify.localOnly` (o `task.localOnly`) **omite la verificación
remota** y cierra en `needs-approval`; el **lint de acceptance** (`lib/guards.mjs`,
`lintAcceptance`) avisa si una orden cita rutas protegidas, ignoradas por git o
inexistentes (T-08).

## 18. Tickets post-mortem (2026-09-24) — resueltos

Todos los tickets T-01..T-12 están implementados:
- **T-01** el ledger registra todos los roles (scout/author/verifier/security/merge/scribe).
- **T-02** timeout del verifier = `UNKNOWN` + reintento (rota el modelo); no cierra en FAIL.
- **T-03** (a) diff vacío no gasta gate/verifier; (b) baseline de gates (`gates.baseline`).
- **T-04** `dispatch --detach` (proceso detached) + `status --run <id>` / `--runs`.
- **T-05** guards de egress (`lib/guards.mjs` + hook `tool_call`) y `verify.localOnly`.
- **T-06** `--keys-check` en paralelo, clasifica 402 (saldo) vs 429 (cuota) y cruza `/usage`.
- **T-07** `pickKey` prioriza por cuota (`keys.maxQuotaPct`).
- **T-08** lint de acceptance (rutas protegidas/gitignored/inexistentes).
- **T-09** `--session-dir` efímero (SoL-Pi) en vez de `--no-session`.
- **T-10** validación del mapa del scout (`looksLikeMap`) + reintento; no cachea basura.
- **T-11** `gates.requireChangedFiles`.
- **T-12** guard de comandos peligrosos + log `<rol>.commands.log`.

Además, la creación/borrado de worktrees se serializa con la cola `git` (evita carreras
entre tareas paralelas).
