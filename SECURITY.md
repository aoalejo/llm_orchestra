# Security Policy

Este es un repositorio **público**. Las credenciales nunca deben commitearse.

## Qué NO va en el repo

- API keys (opencode-go, OpenAI, Anthropic, etc.)
- Tokens de WhatsApp/Meta, Firebase, Mercado Pago
- Archivos `.env` reales
- Cualquier `auth.json`, keystore o certificado

## Dónde van las credenciales

En cada proyecto consumidor, `.orchestra/.env` (ignorado por `.gitignore`):

```
OPENCODE_GO_KEY_ORCHESTRATOR=...
OPENCODE_GO_KEYS=key1,key2   # una o más keys de worker
```

El driver las lee y las pasa por invocación con `pi --api-key`; nunca se escriben
en `STATE.md`, `tasks.json`, `ledger.jsonl` ni logs (el driver enmascara la key).

## Si se filtra una credencial

1. Rotala/invalidala en el proveedor de inmediato.
2. Purgá el historial: `git filter-repo --path .env --invert-paths`.
3. Fuerza el push y avisá a los colaboradores.

## Reportar

Abrí un issue privado o contactá al mantenedor. No publiques la key filtrada.

## Egress a proveedores (workers en la nube)

Los workers corren con un modelo remoto, así que **lo que leen puede salir de tu máquina**.
Desde el post-mortem 2026-09-24 hay guardarraíles:

- `config.guards.denyRead` (globs): bloquea la **lectura** de `.orchestra/.env`, `**/.env`,
  `**/*.pem`, `**/*.key`, `.ssh`, `.aws`, claves, etc. Se aplica en el hook `tool_call` de la
  extensión (también en los `pi` headless de los workers).
- `config.guards.denyCommands` (regex): bloquea comandos peligrosos (`taskkill`, `docker compose`,
  `systemctl restart`, `run_proto`, …) y loguea cada comando en `<rol>.commands.log`.
- `verify.localOnly: true` (o `task.localOnly`): la tarea **no llama a ningún modelo remoto** y
  cierra en `needs-approval` para revisión humana.
- El **lint de acceptance** avisa si una orden cita rutas protegidas, ignoradas por git o
  inexistentes (fixtures/datos locales).

Regla: **a la nube sólo viajan código y métricas agregadas**; nunca datos de clientes,
`.env` ni bases/archivos ignorados por git.
