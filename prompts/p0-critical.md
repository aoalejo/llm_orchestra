---
description: Ciclo crítico con doble verificación y revisión de seguridad
---
Ejecutá un ciclo **crítico** del Lean Orchestrator para `$ARGUMENTS`.

Diferencias contra el ciclo normal:
- Se exige **doble verificación** con dos modelos distintos + `security-reviewer`.
- Cualquier finding `high` bloquea el PASS.
- Al terminar, el orquestador decide; si aprueba y la ruta es protegida,
  se requiere aprobación humana (`--yes`) antes del commit.

Recordatorio: pagos, stock, precios, auth y migraciones son rutas protegidas.
