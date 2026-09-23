---
description: Ciclo crítico con doble verificación y revisión de seguridad (modo chat)
---
Ejecutá un ciclo **crítico** del Lean Orchestrator para `$ARGUMENTS`.

Diferencias contra el ciclo normal:
- Se exige **doble verificación** con dos modelos distintos + `security-reviewer`.
- Cualquier finding `high` bloquea el PASS.
- Al terminar, **el orquestador (el chat) decide**: el driver devuelve `needs-approval`
  y vos aprobás con `orchestra approve --task <id> --commit`.
- Si la ruta es protegida, se requiere aprobación humana (`--yes`) y la cuenta del
  orquestador se usa sólo como **última instancia** (`--decisions '{"keys":"use_orchestrator"}'`).

Recordatorio: pagos, stock, precios, auth y migraciones son rutas protegidas.
