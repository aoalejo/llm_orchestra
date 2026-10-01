# pi-orchestra — Lean Orchestrator

Paquete para [pi](https://pi.dev) que implementa un **Ralph loop multi-modelo** con
verificación adversa, worktrees paralelos y rotación de cuentas de `opencode-go`.

Diseñado para trabajar en **cualquier proyecto** de la máquina: el runtime es global
(este paquete) y cada proyecto sólo tiene su carpeta `.orchestra/` con config y estado.

## Características

- **El orquestador es el chat** (vos): decide, despacha work orders y aprueba. No hay una capa
  de management interna; los workers corren el ciclo completo y vuelven con un **resumen compacto**.
- **Tools de pi** (`orchestra_scout`, `orchestra_dispatch`, `orchestra_approve`, `orchestra_reject`,
  `orchestra_status`, `orchestra_models`, `orchestra_report`): el chat despacha **sin salir de la
  conversación**; también están los subcomandos CLI equivalentes.
- **Scout con cache y proveedor externo**: `orchestra scout` reusa resultados por `git HEAD+query`
  y, si hay un server **SocratiCode** (MCP) disponible e indexado, lo usa como fuente
  (`scout.provider: auto|llm|socraticode`). Fallback a scout LLM si no está.
- **Dashboard**: `orchestra dashboard [--interval 2]` (TUI en terminal) y panel/widget dentro de
  pi que se refresca mientras el orquestador despacha.
- **Workers baratos** rotando (default `qwen3.8-flash`, `mimo-v2.6-flash`, `deepseek-v4.1-flash`),
  elegidos por datos con `orchestra models`.
- **Verificación adversa**: un modelo distinto al autor intenta *falsar*.
- **Ciclo Ralph**: autor → gate determinista → verifier → (repetir rotando modelos).
- **Worktrees paralelos** (hasta 4) + **merge agent** ante conflictos.
- **Rotación de 2 cuentas**: orquestador en A, workers en B; si B se agota, el orquestador decide.
- **Presupuesto** (costo + tokens), **anti-loop** con escalado de modelo, **meta-review**, **resume** y **self-test** offline.
- **Runner stub** (`--stub` / `ORCHESTRA_RUNNER=stub`) para correr el ciclo completo sin red.
- **Ranking de modelos** (`orchestra models`): cruza el catálogo real de `opencode-go`
  con el score WebDev de [arena.ai](https://arena.ai/leaderboard/code/webdev) y propone
  (o aplica con `--apply`) los modelos baratos para la rotación y los de escalado.
  Se **refresca solo cada 24 h**; los roles se pueden **pinnear** (`models.pins`) o excluir
  (`models.exclude`), y hay `models.aliases`/`models.scoreOverrides` por modelo.
- **Reporte de costos** (`orchestra report`): costo y llamadas por rol, modelo y tarea desde el ledger.
- **Robusto para desatendido**: timeout por llamada a `pi` (`loop.piTimeoutMs`, default 15 min)
  con kill del árbol, stream/stderr a disco en vivo, heartbeat por tarea y `orchestra --clean`
  para limpiar worktrees sin romper el `node_modules` real.
- **Tests**: self-test de lógica pura + smoke de integración del ciclo completo (runner stub),
  corridos en CI (ubuntu/windows × node 20/22) con `npm test`.
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
pi install git:git@github.com:aoalejo/llm_orchestra@v0.2.1
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
orchestra --task <id> --stub   # ciclo offline (sin red ni keys) para probar el pipeline
orchestra scout --query "dónde está el router de pagos" --json
orchestra scout --provider socraticode --query "..."   # usa SocratiCode (MCP) si está
orchestra dispatch --order '{"goal":"...","acceptance":["..."],"scope":["src/..."]}' --json
orchestra approve --task <id> --commit        # el chat aprueba e integra
orchestra status --json                       # estado de tareas
orchestra usage                               # % de cuota por cuenta
orchestra dashboard [--interval 2]            # dashboard TUI (Ctrl+C para salir)
orchestra models               # ranking de modelos (opencode-go + arena.ai)
orchestra models --apply       # aplica la rotación recomendada a config.json
orchestra --keys-status        # ver cuentas configuradas
orchestra --plan               # el orquestador planifica
orchestra --task <id> --dry-run
orchestra --task <id> --commit
orchestra --all --workers 4
orchestra report               # costos y veredictos del ledger
orchestra --clean [--force]    # limpia worktrees/ramas huérfanas de forma segura
```

O desde pi: `/orchestra --keys-status`, `/orchestra --plan`.

## Estructura

```
orchestra/
  orchestra.mjs        # driver (CLI + runtime)
  lib/                 # implementación modular (loop, runner, worktrees, ranking, ...)
  agents/              # prompts de rol (orchestrator, author, verifier, ...)
  prompts/             # workflow prompts de pi
  templates/           # plantillas para `orchestra init`
  extensions/          # comando /orchestra dentro de pi
  tests/smoke.mjs      # integración del ciclo (sin red, runner stub)
  .github/workflows/   # CI: self-test + smoke
```

En el proyecto consumidor:

```
.orchestra/
  config.json   STATE.md   tasks.json
  env.example   .gitignore
  models.generated.json      # ranking de modelos (git-ignored)
  runs/ scratch/ worktrees/   (git-ignored)
```

## Modelos y cuentas

Los nombres son el **default de la plantilla**; `orchestra models --apply` los recalcula
contra el catálogo vivo de `opencode-go` y el score de arena.ai (ver arriba).

| Rol | Modelo(s) por defecto | Cuenta |
|---|---|---|
| Orquestador (el chat) | el modelo de tu sesión de pi | tu `auth.json` |
| Autores | `qwen3.8-flash`, `mimo-v2.6-flash`, `deepseek-v4.1-flash` | B |
| Verifiers | los mismos, rotados (nunca el autor del ciclo) | B |
| Security / scout / scribe | `qwen3.8-flash` | B |
| Escalado | top de score (hoy `qwen3.8-max` / `kimi-k3`) | B |

Las keys se pasan por invocación con `pi --api-key` (prioridad 1 sobre `auth.json`/env),
así que nunca se mezclan: el orquestador conserva la cuenta A aunque B se agote.

Las cuentas B van en **una sola** env var, con una o varias keys rotativas:

```bash
OPENCODE_GO_KEYS=key1,key2,key3      # o ["key1","key2"] o una sola key
```

## Proveedores directos (sin rotación)

Para usar una API **por uso** (DeepSeek, MiMo/Xiaomi, etc.) en vez del pool rotativo de `opencode-go`,
partí de [`templates/config.direct.json`](./templates/config.direct.json):

```jsonc
{
  "provider": "deepseek",                       // provider por defecto (modelos sin prefijo)
  "keys": { "mode": "pi-auth" },                // pi maneja las credenciales; sin pool ni rotación
  "roles": {
    "author":   ["deepseek/deepseek-flash"],    // "<provider>/<modelo>" por rol
    "verifier": ["xiaomi-token-plan-sgp/mimo-v2.6-flash"]
  },
  "models": { "rankings": { "enabled": false } }
}
```

- **Proveedor por rol**: cualquier modelo de `roles.*`, `fallback.models` y de escalado puede ir como
  `"<provider>/<modelo>"` (se parte en la **primera** `/`; un id que ya trae barra se escribe con provider
  explícito, `openrouter/qwen/qwen3-coder`). Sin prefijo usa `provider`, así que las configs actuales no cambian.
  "Verificador ≠ autor" compara `provider/modelo`. La key del pool nunca se manda a un modelo de otro provider.
- **`keys.mode`**: `"pool"` (default, el comportamiento de siempre) o `"pi-auth"`: no se pasa `--api-key`, pi usa su
  `~/.pi/agent/auth.json` (o las variables de entorno del proveedor), Orchestra no lee env vars de keys y
  `--keys-status` sólo lo informa. No hay rotación: nada se marca "agotado".
- **Errores sin rotación** (sólo `pi-auth`): un `429` reintenta la misma invocación con espera
  (`keys.retryBackoffMs`, default `[30000, 120000, 300000]`); si se agotan, o ante un `401`/`402`/fondos, la tarea
  termina en `provider-unavailable`.
- **Cola colgada** (ambos modos): si pi no emite ningún evento del modelo durante `loop.firstTokenTimeoutMs`
  (default 5 min), se mata el proceso, se reintenta una vez y, si se repite, `provider-unavailable`.
- **`provider-unavailable`** es un estado final (como `needs-decision`): `status`/`dispatch --json` traen
  `decision: { reason: "provider-unavailable", role, model, provider, cause, class, attempts, message }` para que el
  orquestador del chat escale a otro modelo/proveedor o espere. No cambia el exit code (igual que `needs-decision`).
- **Sin fugas**: `usage` y el catálogo de modelos no hacen ninguna request si el provider no es `opencode-go` y no hay
  `providerBaseUrl`; con `pi-auth` el refresco automático de rankings se saltea.

## Seguridad

- Los subagentes ejecutan `pi` con acceso a bash: tratá los agentes como código ejecutable.
- **Guards de subagentes** (`config.guards`): `denyRead` (globs) impide a los workers **leer** rutas
  sensibles (`.orchestra/.env`, `**/.env`, `**/*.pem`, `.ssh`, …) y `denyCommands` (regex) bloquea
  comandos peligrosos (`taskkill`, `docker compose`, `systemctl restart`, `run_proto`, …). Los aplica
  el hook `tool_call` de la extensión (sólo en subagentes) y loguea cada comando en
  `<rol>.commands.log`. `enabled:false` los desactiva.
- **Datos sensibles**: `verify.localOnly: true` (o `task.localOnly: true`) hace que la tarea
  **no llame a ningún modelo remoto** y cierre en `needs-approval`; el dispatch además avisa si una
  `acceptance` cita rutas protegidas, ignoradas por git o inexistentes.
- Las rutas en `protectedPaths` requieren `--yes` (aprobación humana) para commitear.
- **Este repo es público: nunca commitear credenciales.** Las keys van en `.orchestra/.env` del proyecto consumidor (ignorado por `.gitignore`). El archivo `templates/env.example` sólo tiene claves vacías.
- Si una key se filtra, rotala en el proveedor y purgá el historial (`git filter-repo`).

## Licencia

MIT
