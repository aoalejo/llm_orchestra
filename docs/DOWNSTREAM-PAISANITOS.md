# Proyecto downstream (ejemplo de uso real)

> Esta herramienta no nació abstracta: se creó para ejecutar trabajos de un
> **monorepo privado de producción** (backend NestJS+Prisma, app mobile React Native,
> web y backoffice Vite+React). Este doc resume el patrón para cualquier proyecto
> consumidor, sin volcar detalles sensibles del cliente.

## Patrón de un proyecto consumidor

```
<proyecto>/
  .orchestra/
    config.json      # gates + protectedPaths + roles de ESE proyecto
    STATE.md         # contexto global
    tasks.json       # backlog con contrato/acceptance
    .env             # cuentas A/B (ignorado por git)
    runs/ scratch/ worktrees/   # artefactos (ignorados)
  docs/plan/
    MODO-DE-TRABAJO.md          # cómo se trabaja
    CUMPLIMIENTO-*.md           # matriz de estado del contrato/spec
```

Registrar el proyecto en el `AGENTS.md`/docs del consumidor apuntando acá
(`F:/Proyectos/orchestra` o el repo git).

## Flujo típico en un consumidor

1. `orchestra init` (o copiar `.orchestra/` existente).
2. Editar `config.json`: `gates` (lint/typecheck/tests/build por app) y `protectedPaths`.
3. Armar `tasks.json` a partir de la matriz de gaps/spec, con:
   - `id`, `title`, `risk`, `contractRef`, `targets`, `scope`, `acceptance`.
4. `orchestra --plan` → el orquestador setea `STATE.md`.
5. `orchestra --task <id> --dry-run` → validar sin commitear.
6. `orchestra --task <id> --commit` / `--all --workers 4`.
7. El `scribe` actualiza la matriz de cumplimiento del consumidor.

## Backlog inicial de ejemplo (categorías P0)

Los primeros trabajos del caso real fueron, en orden:

1. **Correctitud de pagos** — no auto-aprobar medios manuales (el backend marcaba todo como cobrado).
2. **Seguridad** — validar modificadores server-side y no confiar precios del cliente.
3. **Cancelación de pedidos por el cliente** — endpoint + guardas de estado + UI.
4. **Recuperación de contraseña del backoffice** — rutas que estaban en un módulo legacy no montado.
5. **Validación de zona de entrega** — resolver zona por dirección en vez de tomar la primera.
6. **Reserva de stock con vencimiento** + **idempotencia** de pedidos.

Detalle completo y estado: en el repo del consumidor
(`docs/plan/CUMPLIMIENTO-ANEXO-v1.6.md` y `.orchestra/tasks.json`).

## Qué debe saber un agente si va a trabajar en el consumidor

- El runtime es **este** paquete; el consumidor sólo tiene su `.orchestra/`.
- Los paths protegidos y gates son **del proyecto**, no del runtime.
- No mover el backlog de producto a este repo: `tasks.json` es por proyecto.
