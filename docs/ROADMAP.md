# Roadmap y limitaciones

## Limitaciones conocidas (v2)

- **Integración sólo `merge-branch`.** No hay `patch-apply` ni rebase automático.
- **Worktree + node_modules**: se enlazan por junction (Windows) o symlink. Si el enlace
  falla, el driver cae a trabajar en ROOT (serializa de hecho).
- **Merge agent best-effort**: puede resolver conflictos simples; conflictos complejos
  quedan para humano.
- **Detección de agotamiento heurística** (regex sobre errores): puede dar falsos positivos/negativos
  (mitigado porque sólo mira transporte, no el texto del modelo).
- **Tests**: self-test de lógica pura (105 casos) + `tests/smoke.mjs` (39 invariantes del ciclo
  completo con runner stub en un repo temporal), ambos en CI. Falta cobertura de los caminos
  con red real (pi/provider) y de resolución de conflictos complejos del merge-agent.
- **Sin provider además de `opencode-go` cableado** (aunque `provider` es config).
- **Costo**: `lib/cost.mjs` estima por historial, pero no hay routing previo por costo.
- **Paralelismo real**: hasta 4; los gates compiten por CPU y pueden ser el cuello. El merge y el scribe están serializados por cola.

## Implementado desde v2 (antes en ideas)

- Runner **stub** integrado (`--stub` / `ORCHESTRA_RUNNER=stub`): loop completo sin red ni keys.
- **Presupuesto por tokens** (input/output), no sólo costo, chequeado tras autor y verificación.
- **Escalado de modelo** por anti-loop (`escalateModel` fija `state.forcedAuthor`).
- **Fallback real**: `ALLOW_WORKER_FALLBACK` y `useFallbackModels` (cuenta A o `fallback.models`).
- **Rutas protegidas por diff real**, no sólo por `scope` declarado.
- **Limpieza de rama** `orchestra/<id>` tras integrar.
- **Ranking de modelos** (`orchestra models`) contra el catálogo opencode-go + arena.ai,
  con `--apply` y auto-refresh cada 24 h (`models.rankings`); portado de `aoalejo/opencode_mcp`.
- **Pins / exclude / overrides** por modelo (`models.pins`, `models.exclude`, `scoreOverrides`,
  `aliases`) para congelar o descartar modelos.
- **Cuentas B en una sola env var** (`OPENCODE_GO_KEYS`) con 1..N keys rotativas.
- **Match robusto a arena**: aliases (`qwen3.8-flash` → `qwen3.8-flash-next`), sufijos no
  semánticos del id (`muse-spark-1.3-contributor`), overrides manuales (`mimo-v2.6-flash`)
  e inferencia por familia (hereda del hermano de costo más parecido).
- **Modo chat**: se eliminó el orquestador LLM interno; el chat decide y aprueba
  (`needs-approval`/`needs-decision`) con **work orders** (`goal`+`acceptance`+`scope`).
- **Tools de pi** (`orchestra_scout/dispatch/approve/reject/status/usage/models/report/dashboard`).
- **Scout con cache** por `git HEAD+query+scope` y **proveedor SocratiCode** (MCP externo) con
  fallback a LLM (`lib/mcp.mjs` + `lib/scout.mjs`).
- **Cuota real** (`GET /usage`: rolling/weekly/monthly) + **estimador de costo** (`lib/cost.mjs`).
- **Dashboard** (`orchestra dashboard` TUI + panel/widget dentro de pi).
- **Robustez para desatendido**: timeout de pi + kill del árbol, streaming a disco, heartbeat y
  `orchestra --clean` (deslinkea junctions antes de borrar).
- **Reporte de costos** (`orchestra report`) desde el ledger.
- **CI** (GitHub Actions) + **smoke test** de integración del ciclo.
- **Manejo de señales**: SIGINT/SIGTERM limpia worktrees a medio hacer.

## Ideas v3

1. **Routing de costos**: elegir el modelo más barato que pueda según el rol/riesgo y escalar
   sólo tras fallos; estimación previa de costo por tarea (hoy sólo estimación post-hoc).
2. **Progreso medible**: métrica de "findings decrecientes" además de la firma repetida.
3. **Meta-review con muestreo adaptativo** (subir si la tasa de OVERTURN crece).
4. **`patch-apply` / rebase** como estrategia de integración alternativa.
5. **Provider fallback** a otros proveedores (LiteLLM/vLLM/OpenRouter), con fallback por
   errores de transporte/cuota.
6. **Soporte de múltiples cuentas A** (pool de orquestadores) y balanceo.
7. **Skills de pi** para los workflows (`/implement-and-review` nativo).
8. **Firma de findings normalizada con embeddings** (detectar estancamiento semántico, no textual).
9. **Política de reintentos por modelo** (re-roll con el mismo prompt en otro modelo).

## Deuda técnica

- **Adelgazar el entrypoint**: según el grafo de SocratiCode, `orchestra.mjs` sigue siendo el hub
  más conectado (23 conexiones) por `selfTest`/`main`; se puede mover a `lib/selftest.mjs` y
  `lib/cli.mjs`.
- Partir `lib/loop.mjs` en `author/verify/integrate` (opcional).
- Cobertura de errores de red reales (timeouts de pi, respuestas truncadas) con un runner fake.

## Cambios de contrato

- `config.json` es la interfaz estable. Agregar campos es retrocompatible; renombrar rompe.
- Los agentes son prompts: cambiarlos no rompe el runtime.
