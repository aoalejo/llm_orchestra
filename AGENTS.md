# AGENTS.md — Guía para agentes que trabajan en este repo

> Contexto de arranque para cualquier agente de IA (pi u otro) que caiga en
> `llm_orchestra`. Leé esto primero; después seguí los links.

## Qué es este repo

`llm_orchestra` (paquete pi `llm-orchestra`) implementa un **Lean Orchestrator**:
un orquestador grande + workers baratos, con **Ralph loop**, **verificación adversa**
y **rotación de cuentas**, para resolver tareas de programación en cualquier proyecto.

- No es un producto final: es una **herramienta de trabajo** para pi.
- El runtime es global (este paquete); cada proyecto consumidor sólo tiene `.orchestra/`.
- Es un **repo público**: nunca commitear credenciales (ver `SECURITY.md`).

## TL;DR

```bash
# Verificar el runtime
node orchestra.mjs --self-test        # 55/55 (lógica pura)
node tests/smoke.mjs                  # 20/20 (ciclo completo, repo temporal, sin red)
npm test                              # ambos
node orchestra.mjs --help

# Ciclo offline (sin red ni keys) — valida el pipeline completo
node orchestra.mjs --task <id> --stub --dry-run

# Ranking de modelos (catálogo opencode-go + arena.ai)
node orchestra.mjs models
node orchestra.mjs models --apply

# En un proyecto consumidor
cd /ruta/al/proyecto
orchestra init                        # scaffold .orchestra/
cp .orchestra/env.example .orchestra/.env   # cargar cuentas A y B
orchestra --keys-status
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
| `orchestra.mjs` | Driver completo (CLI + runtime). Única dependencia: Node ≥20. |
| `lib/*.mjs` | Ranking de modelos: `models.mjs` (catálogo/refresh), `rank.mjs` (pools), `leaderboard.mjs` (arena.ai). |
| `agents/*.md` | Prompts de rol (orchestrator, author, verifier, security-reviewer, scout, scribe, merge-agent). |
| `prompts/*.md` | Prompt templates de pi (`/ralph-cycle`, `/p0-critical`). |
| `templates/*` | Plantillas que usa `orchestra init`. |
| `extensions/orchestra.ts` | Comando `/orchestra` dentro de pi. |
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

- **Cuenta A** (`OPENCODE_GO_KEY_ORCHESTRATOR`) → orquestador/juez. Reservada.
- **Cuenta B** (`OPENCODE_GO_KEY_WORKER_1`, opcional `_2`) → workers/verifiers.
- Las keys se pasan por invocación con `pi --api-key` (prioridad 1 sobre `auth.json`/env).
- Si B se agota: rota a la 2ª; si no, el orquestador decide (`ALLOW_WORKER_FALLBACK=1` → usar A; si no, `fallback.models` o parquear).

## Cómo trabajar acá (agente nuevo)

1. Corré `npm test` (self-test 55/55 + smoke 20/20). Si no pasa, arreglá eso primero.
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
- El `selfTest` no usa red ni keys (55 casos); `tests/smoke.mjs` valida el ciclo (20 invariantes).
- **arena.ai es scraping**: si cambia el markup, `models` falla explícitamente ("0 filas") en vez
  de rankear con datos vacíos. Los scores por `override`/`family` son estimaciones: se avisan por warn.
- `models.generated.json` y `config.json.bak` están git-ignored en el proyecto consumidor.
