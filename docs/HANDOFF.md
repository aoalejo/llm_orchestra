# HANDOFF — Estado actual y próximos pasos

> Documento para que un agente nuevo retome sin contexto previo.

## Estado (2026-09-22)

- **Paquete v0.2.1**, publicado en `https://github.com/aoalejo/llm_orchestra` (público, rama `main`, tags `v0.2.0` y `v0.2.1`).
- Instalado en pi global (`~/.pi/agent/settings.json` → `"F:\\Proyectos\\orchestra"`).
- `pi list` lo muestra; `pi --list-models` carga sin errores (extensión + prompts válidos).
- `node orchestra.mjs --self-test` → **117/117 OK**; `node tests/smoke.mjs` → **39/39 OK** (`npm test`).
- **CI** en GitHub Actions (`.github/workflows/ci.yml`): self-test + smoke en ubuntu/windows × node 20/22.
- Runtime v2 completo: worktrees paralelos, merge agent, scout, anti-loop, meta-review,
  presupuesto (costo + tokens), resume, rotación de cuentas A/B, `--keys-status`, `orchestra init`.
- **Runner stub** (`--stub`) para correr el ciclo completo sin red ni keys (validado en repo temporal:
  scout → autor → gate → verifier → aprobación → merge).
- **Ranking de modelos** (`orchestra models`): catálogo opencode-go + arena.ai → pools de
  rotación baratos y escalado; `--apply` los escribe en `config.json`.
- **Reporte de costos** (`orchestra report [--json]`) desde `.orchestra/ledger.jsonl`.

## Mejoras del ciclo aplicadas después de v0.2.1

1. `.orchestra/.env` se carga **antes** de `resolvePi` (el `ORCHESTRA_PI_CLI` del `.env` ahora sí se usa).
2. **dry-run** deja de mutar el backlog: no corre `scribe` ni marca `done`.
3. Rutas protegidas se chequean también contra los **archivos que el diff realmente tocó**.
4. Al agotarse la cuenta B, el driver **re-resuelve** la key (antes el autor corría con `apiKey: undefined`).
5. `ALLOW_WORKER_FALLBACK` y `useFallbackModels` implementados (cuenta A o `fallback.models`).
6. `escalateModel` del anti-loop ahora fija el autor de escalado (`state.forcedAuthor`).
7. Presupuesto por **tokens** además de costo, chequeado tras autor y verificación.
8. **Colas FIFO** serializan merge en `ROOT`, `scribe` y escritura de `tasks.json` en paralelo;
   se relee `tasks.json` fresco antes de escribir.
9. `--workers` inválido ya no produce `NaN`.
10. Limpieza de la rama `orchestra/<id>` tras integrar.
11. Gate: si la tarea no declara `targets`, se ignoran las claves `$comment` de `config.gates`
    (antes se ejecutaban como comando shell). Extraído a `gateCommands()` con test.
12. **Ranking de modelos** (`orchestra models [--apply]`) en `lib/`: catálogo vivo de
    opencode-go + costos de pi + score WebDev de arena.ai → pools de rotación y escalado.
    Auto-refresh configurable (`models.rankings`).
13. **Match de arena robusto**: aliases (`qwen3.8-flash` → `qwen3.8-flash-next`), sufijos no
    semánticos del id (`muse-spark-1.3-contributor`), overrides manuales (`mimo-v2.6-flash`)
    e inferencia por familia desde el hermano de costo más parecido (marcada `inferred`).
14. **Falso positivo de "key agotada"**: la detección ya no mira el texto del modelo, sólo
    stderr/`errorMessage` (un author de pagos escribe `402`/`quota`/`insufficient` en el código).
15. **`pathsConflict` por segmentos**: `orders/` ya no matchea `orders-v2/`.
16. **Genérico**: se desacopló del proyecto downstream (prompts, gates/protectedPaths de la
    plantilla, `worktrees.link` configurable, commit message default).
17. **`orchestra report`** (costo por rol/modelo/tarea) + **smoke test** de integración + **CI**.
18. **Señales**: SIGINT/SIGTERM limpia los worktrees a medio hacer (conserva los aprobados).
19. **`models --apply` también ajusta roles de servicio** (`scout`/`scribe`/`security`/`merge`)
    con el mejor modelo barato; se puede desactivar con `models.applyServiceRoles: false`.
20. **Modularización**: `orchestra.mjs` pasó de 1151 a 325 líneas; la lógica vive en `lib/`
    (loop, runner, worktrees, keys, pure, report, modelscmd, etc.).
21. **Refresh cada 24 h**: `models.rankings.maxAgeHours` (default 24, acepta `maxAgeDays`
    legacy); si `models.generated.json` está viejo, se refresca y (con `autoApply`) se aplica.
    Nuevos: `models.pins` (por rol), `models.exclude` (blocklist) y aviso de pins activos.
22. **Cuentas B en una sola env var**: `OPENCODE_GO_KEYS` con 1..N keys (JSON o separadas por
    comas/newlines), usadas **rotativamente** por subagente; `config.keys.workers` sigue
    aceptando el array legacy de env vars. `keys-status` muestra `<envVar>#<idx>`.
23. **Timeout de pi** (`loop.piTimeoutMs`, default 15 min): mata el **árbol** del proceso
    (taskkill /T en Windows), marca `timedOut` y lo trata como fallo reintentable; el `logFile`
    se escribe siempre (antes un cuelgue no dejaba evidencia).
24. **Streaming en vivo**: `<rol>.stream.jsonl` (una línea por evento) y `<rol>.stderr.log`.
25. **Heartbeat**: `runs/<task>/heartbeat.json` (`{ts,pid,role,silentMs,timeoutMs}`) + aviso
    "sin datos desde Xs" con `--verbose`.
26. **`orchestra --clean [--force]`**: limpieza segura de worktrees/ramas huérfanas; deslinkea
    los junctions antes de borrar (evita destruir el `node_modules` real) y conserva los aprobados.
27. **Modo chat**: se ELIMINÓ el orquestador LLM interno (`qwen3.8-max`) y el meta-review. El
    loop devuelve `needs-approval` (todo verde) o `needs-decision` (cuota/estancamiento) al chat,
    que decide. `--commit`/`--yes` mantiene el flujo desatendido; `--plan` ya no usa LLM.
28. **Subcomandos de chat** (`lib/commands.mjs`): `scout`, `dispatch` (1..N work orders en
    paralelo), `approve`, `reject`, `status`, con salida `--json` **compacta** (sin transcripts).
29. **Work orders**: `normalizeWorkOrder`/`validateWorkOrder` (goal + acceptance + scope +
    targets + risk); el driver los normaliza, valida y persiste en `tasks.json`.
30. **Worktree reuse**: `approve`/resume reusa el worktree existente en vez de recrearlo, así
    no se pierden los cambios del autor entre `dispatch` y `approve`.
31. Se quitó `agents/orchestrator.md`; `roles.orchestrator` queda sólo para `--keys-check`.
32. **Tools de pi** (`extensions/orchestra.ts`): `orchestra_scout`, `orchestra_dispatch`,
    `orchestra_approve`, `orchestra_reject`, `orchestra_status`, `orchestra_models`,
    `orchestra_report`. El chat despacha sin salir de la conversación; las tools invocan el
    driver con `--json` y devuelven sólo el resumen compacto.
33. **Scout con cache + SocratiCode**: `lib/mcp.mjs` (cliente MCP stdio mínimo, sin deps) +
    `lib/scout.mjs`. `scout.provider: auto|llm|socraticode`: si SocratiCode está disponible e
    indexado, se usa `codebase_search` como contexto (o directo con `synthesize:false`); si no,
    fallback a scout LLM. Cache en `runs/scout/cache/` keyed por `git HEAD+query+scope`.
    Flags: `--provider`, `--no-cache`, `--index`.
34. **Cuota real**: `GET {baseUrl}/usage` (rolling/weekly/monthly %) descubierto en vivo;
    `lib/usage.mjs` + `orchestra usage [--json]` + tool `orchestra_usage` (cache 60 s).
35. **Estimador de costo** (`lib/cost.mjs`): `estimateRemaining` desde el ledger; cuando B se
    agota, `needs-decision` incluye `estimatedRemainingUsd`, `estimate` y `orchestratorQuota`
    para que el chat decida (A es última instancia).
36. **Dashboard** (`lib/dashboard.mjs`): `orchestra dashboard` (TUI ANSI, fases 1) +
    panel/widget dentro de pi (`orchestra_dashboard`, `/orchestra-dashboard`) que se refresca
    mientras corre un dispatch (fase 2).

## Qué falta (para ejecutar el primer trabajo real)

Nada de código: sólo **credenciales**.

1. En tu proyecto consumidor:
   ```bash
   cp .orchestra/env.example .orchestra/.env
   # OPENCODE_GO_KEY_ORCHESTRATOR = cuenta A
   # OPENCODE_GO_KEYS             = cuenta(s) B (key1,key2 o ["k1","k2"])
   ```
2. `orchestra --keys-status` debe mostrar A y B cargadas (enmascaradas).
   `orchestra --keys-check` además prueba cada una con una llamada real y avisa
   si alguna quedó sin saldo (`insufficient funds`).
3. `orchestra --task <id> --dry-run` para validar el flujo sin commitear.

## Decisiones tomadas con el usuario (no re-litigar)

1. Paralelismo: **máx 4** workers.
2. Verificación **adversa + ciclado de modelos en TODA codificación**; el orquestador **sólo revisa**.
3. **Sólo el orquestador commitea.**
4. Rutas protegidas (pagos, auth, migraciones, puntos) requieren **aprobación humana** (`--yes`).
5. Repo **público** → nunca commitear credenciales.
6. Rotación de cuentas: orquestador en A, workers en B (así el orquestador sobrevive si B se agota).

## Preguntas abiertas para el humano

- ¿Quién valida QA además del gate + verificación adversa?

## Cómo correr el orchestrator (resumen)

```bash
node orchestra.mjs --self-test
node orchestra.mjs --keys-status
node orchestra.mjs --task <id> --stub --dry-run   # pipeline offline, sin red ni keys
node orchestra.mjs models                         # ranking opencode-go + arena.ai
node orchestra.mjs models --apply                 # aplica rotación a config.json
node orchestra.mjs --plan
node orchestra.mjs --task <id> --dry-run
node orchestra.mjs --task <id> --commit
node orchestra.mjs --all --workers 4
```

En pi: `/orchestra --plan`, `/orchestra --keys-status`.

## Flujo de publicación

```bash
# cambios en este repo
node orchestra.mjs --self-test
git add -A && git commit -m "feat: ..."
git tag -a v0.3.0 -m "..."
git push origin main --tags
# en cada PC
pi update --extensions
```

## Tickets post-mortem (2026-09-24)

Implementados **T-01..T-12** (ver `docs/ARCHITECTURE.md` §18 y `docs/TICKETS.md`): ledger por
rol, verifier timeout reintentable, diff vacío/baseline de gates, `dispatch --detach`,
guards de egress/contención, keys-check 402/429 + `/usage`, keys por cuota, lint de
acceptance, `--session-dir` (SoL-Pi), validación del scout y `gates.requireChangedFiles`.

## Grill P1/P2 (2026-09-24)

- **P1**: `selfTest` extraído a `lib/selftest.mjs` (`orchestra.mjs` 489→197 líneas); T-09
  verificado (con `--no-session` SoL-Pi tira error, con `--session-dir` no); `status --run`
  marca runs muertos (`dead`); `guards.denyRead` permite `.env.example/.sample/.template`;
  cache de `/usage` a 10 min (`keys.usageCacheMs`) y la tool `orchestra_dashboard` usa `--no-usage`.
- **P2**: la extensión importa el matcher de `lib/guards.mjs` (sin duplicarlo); `lib/loop.mjs`
  partido en `author`/`verify`/`integrate`; se quitó el backlog downstream (Paisanitos) del HANDOFF.
