# AGENTS.md — Guía para agentes que trabajan en este repo

> Contexto de arranque para cualquier agente de IA (pi u otro) que caiga en
> `llm_orchestra`. Leé esto primero; después seguí los links.

## Qué es este repo

`llm_orchestra` (paquete pi `llm-orchestra`) implementa un **Lean Orchestrator**:
**el orquestador es el chat** (vos) que despacha work orders a workers baratos; los workers
corren el ciclo completo (autor → gate → verifier → rondas) y vuelven con un **resumen
compacto**, con **verificación adversa** y **rotación de cuentas**.

- No es un producto final: es una **herramienta de trabajo** para pi.
- El runtime es global (este paquete); cada proyecto consumidor sólo tiene `.orchestra/`.
- Es un **repo público**: nunca commitear credenciales (ver `SECURITY.md`).

## TL;DR

```bash
# Verificar el runtime
node orchestra.mjs --self-test        # 105/105 (lógica pura)
node tests/smoke.mjs                  # 39/39 (ciclo completo, repo temporal, sin red)
npm test                              # ambos
node orchestra.mjs --help

# Ciclo offline (sin red ni keys) — valida el pipeline completo
node orchestra.mjs --task <id> --stub --dry-run

# Ranking de modelos (catálogo opencode-go + arena.ai)
node orchestra.mjs models
node orchestra.mjs models --apply

# Modo chat (el orquestador sos vos)
node orchestra.mjs scout --query "dónde está el router de pagos" --json
node orchestra.mjs dispatch --order '{"goal":"...","acceptance":["..."],"scope":["src/..."]}' --json
node orchestra.mjs approve --task <id> --commit
node orchestra.mjs status --json
node orchestra.mjs dashboard --once

# Limpieza segura de worktrees huérfanos (no rompe el node_modules real)
node orchestra.mjs --clean

# En un proyecto consumidor
cd /ruta/al/proyecto
orchestra init                        # scaffold .orchestra/
cp .orchestra/env.example .orchestra/.env   # cargar cuentas A y B
orchestra --keys-status
orchestra --keys-check    # llamada real por key: cuál responde y cuál está agotada
orchestra --plan
orchestra --task <id> --dry-run
orchestra --task <id> --commit
orchestra --all --workers 4
```

Desde pi: `/orchestra …`.

## Arquitectura en 30 segundos

```
qwen3.8-max (orquestador, cuenta A)  →  plan / escalado / aprobación / meta-review
       │
       └─ por tarea (hasta 4 en paralelo, cada una en su git worktree):
            scout → autor (barato, cuenta B) → gate determinista
                  → verifier adversario (modelo ≠ autor)
                  → [alto riesgo] 2º verifier + security-reviewer
                  → orquestador APPROVE → commit (solo orquestador) → merge
```

Reglas duras:
1. Verificación adversa + ciclado de modelos en **toda** codificación.
2. **Solo el orquestador commitea** (el driver ejecuta git en su nombre).
3. Rutas en `protectedPaths` → **aprobar humano** con `--yes`.
4. Sin secretos. Migraciones versionadas.

## Mapa de archivos

| Archivo | Qué es |
|---|---|
| `orchestra.mjs` | Entrypoint/CLI (325 líneas): `init`, `models`, `report`, `selfTest`, `main`. |
| `lib/*.mjs` | Implementación: `loop` (autor/verifier/rondas/integración), `commands` (scout/dispatch/approve/reject/status/usage), `scout`+`mcp` (proveedor SocratiCode), `usage`+`cost` (cuota/estimación), `dashboard`, `runner` (pi/procesos), `worktrees`, `keys`, `pure` (lógica testeable), `models`/`rank`/`leaderboard` (ranking), `modelscmd`, `report`, `stub`, `agents`, `args`, `paths`, `log`, `util`. |
| `agents/*.md` | Prompts de rol (orchestrator, author, verifier, security-reviewer, scout, scribe, merge-agent). |
| `prompts/*.md` | Prompt templates de pi (`/ralph-cycle`, `/p0-critical`). |
| `templates/*` | Plantillas que usa `orchestra init`. |
| `extensions/orchestra.ts` | Comando `/orchestra` + **tools** (`orchestra_scout`, `orchestra_dispatch`, `orchestra_approve`, `orchestra_reject`, `orchestra_status`, `orchestra_models`, `orchestra_report`). |
| `tests/smoke.mjs` | Integración del ciclo completo con runner stub (repo git temporal). |
| `.github/workflows/ci.yml` | CI: self-test + smoke en ubuntu/windows × node 20/22. |
| `docs/` | Documentación profunda (ver abajo). |
| `package.json` | Manifiesto pi (`extensions`, `prompts`) + `bin: orchestra`. |

## Documentación

- `docs/ARCHITECTURE.md` — diseño interno del driver, config, worktrees, keys, artefactos.
- `docs/HANDOFF.md` — **estado actual y próximos pasos** (empezá por acá si continuás).
- `docs/DOWNSTREAM-PAISANITOS.md` — el proyecto que originó la herramienta y sus gaps.
- `docs/ROADMAP.md` — limitaciones conocidas e ideas v3.
- `README.md` — uso general e instalación.
- `SECURITY.md` — política de secretos (repo público).

## Modelos (provider `opencode-go`)

La tabla es el **default de la plantilla**. La fuente de verdad es `orchestra models`,
que recalcula los pools contra el catálogo vivo + arena.ai:

| Rol | Modelo | in/out USD/M | ctx |
|---|---|---|---|
| Orquestador/juez | `qwen3.8-max` | 2 / 6 | 1M |
| Autor | `qwen3.8-flash` (arena #9 vía `qwen3.8-flash-next`) | 0.15 / 0.47 | 1M |
| Autor | `mimo-v2.6-flash` (override manual, ≈ #17) | 0.14 / 0.28 | 1M |
| Autor | `deepseek-v4.1-flash` | 0.15 / 0.60 | 1M |
| Barato destacado | `muse-spark-1.3-contributor` (arena #13 vía sufijo) | 0.10 / 0.20 | 1M |
| Security/scout/scribe/merge | `qwen3.8-flash` | 0.15 / 0.47 | 1M |
| Escalado | top de score (hoy `qwen3.8-max` / `kimi-k3`) | 2/6 · 3/15 | 1M |

Catálogo real cacheado en `~/.pi/agent/models-store.json`. Base `https://opencode.ai/zen/go/v1`.

## Cuentas (rotación)

Se configuran en `.orchestra/.env`:

```bash
OPENCODE_GO_KEY_ORCHESTRATOR=...   # cuenta A (orquestador/juez), reservada
OPENCODE_GO_KEYS=key1,key2,key3    # cuenta(s) B: 1 sola var, N keys
```

- **Cuenta A** → orquestador/juez. Reservada (no se rota).
- **Cuentas B** → workers/verifiers. `OPENCODE_GO_KEYS` acepta una sola key,
  una lista separada por comas/newlines, o un JSON array (`["k1","k2"]`).
  El driver las usa **de forma rotativa** entre subagentes y marca las agotadas.
- `config.keys.workers` puede ser el nombre de esa env var (recomendado) o un array de
  nombres de env vars (formato legacy, una por cuenta).
- Las keys se pasan por invocación con `pi --api-key` (prioridad 1 sobre `auth.json`/env),
  así que nunca se mezclan: el orquestador conserva la cuenta A aunque B se agote.
- Si todas las B se agotan: `ALLOW_WORKER_FALLBACK=1` reusa A, o el orquestador decide
  (`useFallbackModels` → usa `fallback.models`, o parkea).

## Cómo trabajar acá (agente nuevo)

1. Corré `npm test` (self-test 105/105 + smoke 39/39). Si no pasa, arreglá eso primero.
2. Para tocar código: implementá + agregá caso al `selfTest()` (lógica pura) o al
   `tests/smoke.mjs` (comportamiento del ciclo) + corré `npm test`.
3. Respetá la invariante "solo el orquestador commitea": los workers no llaman git.
4. Para agregar un modelo/rol: editalo en `templates/config.json` (y en `agents/` si es un rol nuevo).
   Para que un modelo nuevo rankee: agregalo a `models.aliases` o `models.scoreOverrides`.
5. Versioná: commit conventional + `git tag -a vX.Y.Z` + `git push origin main --tags`.
6. Actualizá el paquete instalado: `pi update --extensions`.

## Gotchas conocidos

- **Windows**: los worktrees enlazan dependencias con junction; si falla, el driver cae a ROOT.
  Los patrones son `worktrees.link` (soporta `*`).
- Los gates corren con `shell: true` desde la raíz del worktree; timeout `gates.timeoutMs` (default 20 min).
  Si el proyecto no tiene tests, usá `--passWithNoTests` o sacá el comando del target.
- Si corrés sin `--commit`, el worktree y su rama se **conservan** para inspección (a propósito).
- `--stub` no corre gates reales ni genera diff. Con `ORCHESTRA_STUB_TOUCH=1` el author stub
  deja un cambio real, así se ejercita commit + merge (es lo que hace `tests/smoke.mjs`).
- El `selfTest` no usa red ni keys (110 casos); `tests/smoke.mjs` valida el ciclo (39 invariantes).
- **Timeout de pi**: `loop.piTimeoutMs` (default 15 min). Al vencer mata el árbol y deja
  `<rol>.json` (con `timedOut:true`), `<rol>.stream.jsonl`, `<rol>.stderr.log` y `heartbeat.json`.
- **`--clean`**: si un run murió con `SIGKILL`, corré `orchestra --clean` (deslinkea junctions
  antes de borrar). Nunca borres `.orchestra/worktrees/` a mano: un `git worktree remove`
  atraviesa el junction y borra el `node_modules` real.
- **Guards** (`config.guards`): `denyRead`/`denyCommands` los aplica la extensión en `tool_call`
  (sólo en subagentes) y loguea `<rol>.commands.log`. `verify.localOnly`/`task.localOnly` evita
  mandar datos a la nube. Requiere recargar pi para que tomen efecto.
- **`dispatch --detach`**: devuelve `runId` de inmediato (el loop sigue en background); seguilo con
  `orchestra status --run <id>` (o `--runs`).
- **Modelo no usable → blacklist automática**: si un modelo devuelve el 400 de privacidad del
  proveedor ("This Go model **trains on request data** … Privacy settings"), el loop lo saca de
  **todos** los pools en el acto y lo agrega a `models.exclude` del `config.json` (con la razón en
  `models.blacklistNotes`), que el ranking respeta y no vuelve a proponer. Se detecta con
  `detectUnusableModel` (stderr/`errorMessage`, nunca el texto del modelo) y se reintenta el ciclo
  con otro modelo. Distinto de `detectExhausted` (cuota/saldo de la cuenta: ahí se rota la key).
- **arena.ai es scraping**: si cambia el markup, `models` falla explícitamente ("0 filas") en vez
  de rankear con datos vacíos. Los scores por `override`/`family` son estimaciones: se avisan por warn.
- `models.generated.json` y `config.json.bak` están git-ignored en el proyecto consumidor.
