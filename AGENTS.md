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
node orchestra.mjs --self-test        # 27/27
node orchestra.mjs --help

# Ciclo offline (sin red ni keys) — valida el pipeline completo
node orchestra.mjs --task <id> --stub --dry-run

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
| `agents/*.md` | Prompts de rol (orchestrator, author, verifier, security-reviewer, scout, scribe, merge-agent). |
| `prompts/*.md` | Prompt templates de pi (`/ralph-cycle`, `/p0-critical`). |
| `templates/*` | Plantillas que usa `orchestra init`. |
| `extensions/orchestra.ts` | Comando `/orchestra` dentro de pi. |
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

| Rol | Modelo | in/out USD/M | ctx |
|---|---|---|---|
| Orquestador/juez | `qwen3.8-max` | 2 / 6 | 1M |
| Autor | `mimo-v2.6-flash` | 0.14 / 0.28 | 1M |
| Autor | `deepseek-v4.1-flash` | 0.15 / 0.60 | 1M |
| Autor/verifier/security/scout/scribe/merge | `qwen3.8-flash` | 0.15 / 0.47 | 1M |
| Fallback | `glm-5.3-flash`, `deepseek-v4-flash`, `minimax-m3` | ~0.15–0.3 | 1M |
| Escalado | `kimi-k2.7-code`, `deepseek-v4-pro` | 0.95/4 · 0.66/1.98 | 1M |

Catálogo real cacheado en `~/.pi/agent/models-store.json`. Base `https://opencode.ai/zen/go/v1`.

## Cuentas (rotación)

- **Cuenta A** (`OPENCODE_GO_KEY_ORCHESTRATOR`) → orquestador/juez. Reservada.
- **Cuenta B** (`OPENCODE_GO_KEY_WORKER_1`, opcional `_2`) → workers/verifiers.
- Las keys se pasan por invocación con `pi --api-key` (prioridad 1 sobre `auth.json`/env).
- Si B se agota: rota a la 2ª; si no, el orquestador decide (`ALLOW_WORKER_FALLBACK=1` → usar A; si no, `fallback.models` o parquear).

## Cómo trabajar acá (agente nuevo)

1. Corré `node orchestra.mjs --self-test`. Si no pasa 27/27, arreglá eso primero.
2. Para tocar código: implementá + agregá caso al `selfTest()` + corré el self-test.
3. Respetá la invariante "solo el orquestador commitea": los workers no llaman git.
4. Para agregar un modelo/rol: editalo en `templates/config.json` (y en `agents/` si es un rol nuevo).
5. Versioná: commit conventional + `git tag -a vX.Y.Z` + `git push origin main --tags`.
6. Actualizá el paquete instalado: `pi update --extensions`.

## Gotchas conocidos

- **Windows**: los worktrees enlazan `node_modules` con junction; si falla, el driver cae a ROOT.
- Los gates de mobile usan `yarn --cwd`; puede requerir corepack según el proyecto.
- Backend de Paisanitos hoy tiene 0 tests → el gate corre `--passWithNoTests`.
- Si corrés sin `--commit`, el worktree se **conserva** para inspección (a propósito).
- El `selfTest` no usa red ni keys (hoy 27 casos). Corré el loop completo sin red con `--stub`.
