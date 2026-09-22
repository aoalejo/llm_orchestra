# Roadmap y limitaciones

## Limitaciones conocidas (v2)

- **Integración sólo `merge-branch`.** No hay `patch-apply` ni rebase automático.
- **Worktree + node_modules**: se enlazan por junction (Windows) o symlink. Si el enlace
  falla, el driver cae a trabajar en ROOT (serializa de hecho).
- **Merge agent best-effort**: puede resolver conflictos simples; conflictos complejos
  quedan para humano.
- **Detección de agotamiento heurística** (regex sobre errores): puede dar falsos positivos/negativos.
- **Sin tests formales del driver**: la red de seguridad es `--self-test` (27 casos, lógica pura) y el runner `--stub`, que permite correr el pipeline completo sin red en un repo temporal.
- **Sin provider además de `opencode-go` cableado** (aunque `provider` es config).
- **Costo**: no hay estimación previa por tarea; sólo corte por presupuesto (costo y tokens).
- **Paralelismo real**: hasta 4; los gates compiten por CPU y pueden ser el cuello. El merge y el scribe están serializados por cola.

## Implementado desde v2 (antes en ideas)

- Runner **stub** integrado (`--stub` / `ORCHESTRA_RUNNER=stub`): loop completo sin red ni keys.
- **Presupuesto por tokens** (input/output), no sólo costo, chequeado tras autor y verificación.
- **Escalado de modelo** por anti-loop (`escalateModel` fija `state.forcedAuthor`).
- **Fallback real**: `ALLOW_WORKER_FALLBACK` y `useFallbackModels` (cuenta A o `fallback.models`).
- **Rutas protegidas por diff real**, no sólo por `scope` declarado.
- **Limpieza de rama** `orchestra/<id>` tras integrar.

## Ideas v3

1. **Routing de costos**: elegir el modelo más barato que pueda según el rol/riesgo y
   escalar sólo tras fallos; estimación previa de costo por tarea.
2. **Progreso medible**: métrica de "findings decrecientes" además de la firma repetida.
3. **Meta-review con muestreo adaptativo** (subir si la tasa de OVERTURN crece).
4. **`patch-apply` / rebase** como estrategia de integración alternativa.
5. **Provider fallback** a otros proveedores (no sólo modelos del mismo).
6. **Cache de scout** por tarea/repo (evitar repetir recon).
7. **Dashboard TUI** del ledger (costos por modelo, tasa de aprobación).
8. **Soporte de múltiples cuentas A** (pool de orquestadores) y balanceo.
9. **Skills de pi** para los workflows (`/implement-and-review` nativo).
10. **Firma de findings normalizada con embeddings** (detectar estancamiento semántico, no textual).
11. **Política de reintentos por modelo** (re-roll con el mismo prompt en otro modelo).

## Deuda técnica

- Unificar `orchestra.mjs` monolítico en módulos (`lib/`) cuando supere ~1200 líneas.
- Tests de integración del driver **automatizados** en CI usando `--stub` y un repo temporal (hoy se valida a mano).
- Manejo de señales (Ctrl+C) para limpiar worktrees a medio crear.

## Cambios de contrato

- `config.json` es la interfaz estable. Agregar campos es retrocompatible; renombrar rompe.
- Los agentes son prompts: cambiarlos no rompe el runtime.
