# Roadmap y limitaciones

## Limitaciones conocidas (v2)

- **Integración sólo `merge-branch`.** No hay `patch-apply` ni rebase automático.
- **Worktree + node_modules**: se enlazan por junction (Windows) o symlink. Si el enlace
  falla, el driver cae a trabajar en ROOT (serializa de hecho).
- **Merge agent best-effort**: puede resolver conflictos simples; conflictos complejos
  quedan para humano.
- **Detección de agotamiento heurística** (regex sobre errores): puede dar falsos positivos/negativos.
- **Sin tests formales del driver**: la red de seguridad es `--self-test` (lógica pura).
- **Sin provider además de `opencode-go` cableado** (aunque `provider` es config).
- **Costo**: no hay estimación previa por tarea; sólo corte por presupuesto.
- **Paralelismo real**: hasta 4; los gates compiten por CPU y pueden ser el cuello.

## Ideas v3

1. **Routing de costos**: elegir el modelo más barato que pueda según el rol/riesgo y
   escalar sólo tras fallos; estimación previa de costo por tarea.
2. **Progreso medible**: métrica de "findings decrecientes" además de la firma repetida.
3. **Meta-review con muestreo adaptativo** (subir si la tasa de OVERTURN crece).
4. **`patch-apply` / rebase** como estrategia de integración alternativa.
5. **Provider fallback** a otros proveedores (no sólo modelos del mismo).
6. **Runner stub integrado** para correr el loop completo sin red en CI.
7. **Cache de scout** por tarea/repo (evitar repetir recon).
8. **Dashboard TUI** del ledger (costos por modelo, tasa de aprobación).
9. **Soporte de múltiples cuentas A** (pool de orquestadores) y balanceo.
10. **Skills de pi** para los workflows (`/implement-and-review` nativo).
11. **Firma de findings normalizada con embeddings** (detectar estancamiento semántico, no textual).
12. **Política de reintentos por modelo** (re-roll con el mismo prompt en otro modelo).

## Deuda técnica

- Unificar `orchestra.mjs` monolítico en módulos (`lib/`) cuando supere ~1200 líneas.
- Tests de integración del driver usando un repo temporal y runner stub.
- Manejo de señales (Ctrl+C) para limpiar worktrees a medio crear.

## Cambios de contrato

- `config.json` es la interfaz estable. Agregar campos es retrocompatible; renombrar rompe.
- Los agentes son prompts: cambiarlos no rompe el runtime.
