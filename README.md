# pi-orchestra — Lean Orchestrator

Paquete para [pi](https://pi.dev) que implementa un **Ralph loop multi-modelo** con
verificación adversa, worktrees paralelos y rotación de cuentas de `opencode-go`.

Diseñado para trabajar en **cualquier proyecto** de la máquina: el runtime es global
(este paquete) y cada proyecto sólo tiene su carpeta `.orchestra/` con config y estado.

## Características

- **Orquestador grande** (`qwen3.8-max`) que planifica, escala y aprueba; **no** implementa.
- **Workers baratos** (`mimo-v2.6-flash`, `deepseek-v4.1-flash`, `qwen3.8-flash`).
- **Verificación adversa**: un modelo distinto al autor intenta *falsar*.
- **Ciclo Ralph**: autor → gate determinista → verifier → (repetir rotando modelos).
- **Worktrees paralelos** (hasta 4) + **merge agent** ante conflictos.
- **Rotación de 2 cuentas**: orquestador en A, workers en B; si B se agota, el orquestador decide.
- **Presupuesto**, **anti-loop**, **meta-review**, **resume** y **self-test** offline.
- Solo el **orquestador commitea**.

## Documentación

- [`AGENTS.md`](./AGENTS.md) — orientación para agentes de IA (empezá acá).
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — diseño interno del driver.
- [`docs/HANDOFF.md`](./docs/HANDOFF.md) — estado actual y próximos pasos.
- [`docs/DOWNSTREAM-PAISANITOS.md`](./docs/DOWNSTREAM-PAISANITOS.md) — patrón de proyecto consumidor.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — limitaciones e ideas v3.
- [`SECURITY.md`](./SECURITY.md) — política de secretos.

## Instalación

```bash
# Desde GitHub (recomendado)
pi install git:git@github.com:aoalejo/llm_orchestra@v0.2.0
# o
pi install https://github.com/aoalejo/llm_orchestra

# Desde ruta local (desarrollo)
pi install /ruta/a/llm_orchestra
```

Esto registra el paquete a nivel global (`~/.pi/agent/settings.json`) y expone:
- el comando de pi `/orchestra`
- los prompt templates `/ralph-cycle` y `/p0-critical`
- el CLI `orchestra` (si se hizo `npm link` o vía `node <pkg>/orchestra.mjs`)

## Uso en un proyecto

```bash
cd /ruta/a/tu/proyecto
orchestra init                 # crea .orchestra/ desde las plantillas
# editar .orchestra/config.json (gates, protectedPaths)
cp .orchestra/env.example .orchestra/.env   # cargar cuentas A y B

orchestra --self-test          # valida el runtime
orchestra --keys-status        # ver cuentas configuradas
orchestra --plan               # el orquestador planifica
orchestra --task <id> --dry-run
orchestra --task <id> --commit
orchestra --all --workers 4
```

O desde pi: `/orchestra --keys-status`, `/orchestra --plan`.

## Estructura

```
orchestra/
  orchestra.mjs        # driver (CLI + runtime)
  agents/              # prompts de rol (orchestrator, author, verifier, ...)
  prompts/             # workflow prompts de pi
  templates/           # plantillas para `orchestra init`
  extensions/          # comando /orchestra dentro de pi
```

En el proyecto consumidor:

```
.orchestra/
  config.json   STATE.md   tasks.json
  env.example   .gitignore
  runs/ scratch/ worktrees/   (git-ignored)
```

## Modelos y cuentas

| Rol | Modelo(s) | Cuenta |
|---|---|---|
| Orquestador / juez | `qwen3.8-max` | A |
| Autores | `mimo-v2.6-flash`, `deepseek-v4.1-flash`, `qwen3.8-flash` | B |
| Verifiers | rotan (≠ autor) | B |
| Security / scout / scribe | `qwen3.8-flash` | B |
| Escalado | `kimi-k2.7-code` / `deepseek-v4-pro` | B |

Las keys se pasan por invocación con `pi --api-key` (prioridad 1 sobre `auth.json`/env),
así que nunca se mezclan: el orquestador conserva la cuenta A aunque B se agote.

## Seguridad

- Los subagentes ejecutan `pi` con acceso a bash: tratá los agentes como código ejecutable.
- Las rutas en `protectedPaths` requieren `--yes` (aprobación humana) para commitear.
- **Este repo es público: nunca commitear credenciales.** Las keys van en `.orchestra/.env` del proyecto consumidor (ignorado por `.gitignore`). El archivo `templates/env.example` sólo tiene claves vacías.
- Si una key se filtra, rotala en el proveedor y purgá el historial (`git filter-repo`).

## Licencia

MIT
