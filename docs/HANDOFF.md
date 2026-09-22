# HANDOFF — Estado actual y próximos pasos

> Documento para que un agente nuevo retome sin contexto previo.

## Estado (2026-09-22)

- **Paquete v0.2.0**, publicado en `https://github.com/aoalejo/llm_orchestra` (público, rama `main`, tag `v0.2.0`).
- Instalado en pi global (`~/.pi/agent/settings.json` → `"F:\\Proyectos\\orchestra"`).
- `pi list` lo muestra; `pi --list-models` carga sin errores (extensión + prompts válidos).
- `node orchestra.mjs --self-test` → **13/13 OK**.
- Runtime v2 completo: worktrees paralelos, merge agent, scout, anti-loop, meta-review,
  presupuesto, resume, rotación de cuentas A/B, `--keys-status`, `orchestra init`.

## Qué falta (para ejecutar el primer trabajo real)

Nada de código: sólo **credenciales**.

1. En el proyecto consumidor (ej. `gastronomia-monorepo`):
   ```bash
   cp .orchestra/env.example .orchestra/.env
   # OPENCODE_GO_KEY_ORCHESTRATOR = cuenta A
   # OPENCODE_GO_KEY_WORKER_1     = cuenta B
   ```
2. `orchestra --keys-status` debe mostrar A y B cargadas.
3. `orchestra --task p0-manual-payment-approval --dry-run` para validar el flujo sin commitear.

## Decisiones tomadas con el usuario (no re-litigar)

1. Paralelismo: **máx 4** workers.
2. Verificación **adversa + ciclado de modelos en TODA codificación**; el orquestador **sólo revisa**.
3. **Sólo el orquestador commitea.**
4. Rutas protegidas (pagos, auth, migraciones, puntos) requieren **aprobación humana** (`--yes`).
5. Repo **público** → nunca commitear credenciales.
6. Rotación de cuentas: orquestador en A, workers en B (así el orquestador sobrevive si B se agota).

## Próximo trabajo sugerido (P0 de Paisanitos)

El primer backlog vive en el repo consumidor, no acá:
`gastronomia-monorepo/.orchestra/tasks.json` y `docs/plan/CUMPLIMIENTO-ANEXO-v1.6.md`.

Orden sugerido (los de código, sin depender de credenciales externas):
1. `p0-manual-payment-approval` (fix de correctitud)
2. `p0-modifier-price-validation` (seguridad)
3. `p0-customer-cancel`
4. `p0-backoffice-recovery`
5. `p0-delivery-zone-validation`
6. `p0-stock-reservation` / `p0-order-idempotency`
7. `p0-mp-integration` → **bloqueada**: falta decidir cuenta MP única vs OAuth por comercio + sandbox.

## Preguntas abiertas para el humano

- Mercado Pago: ¿cuenta única para todos los comercios o OAuth por comercio?
- ¿Se commitea el scaffold de `.orchestra/` + docs en gastronomía? (hoy untracked)
- ¿Quién valida QA además del gate + verificación adversa?

## Cómo correr el orchestrator (resumen)

```bash
node orchestra.mjs --self-test
node orchestra.mjs --keys-status
node orchestra.mjs --plan
node orchestra.mjs --task <id> --dry-run
node orchestra.mjs --task <id> --commit
node orchestra.mjs --all --workers 4
```

En pi: `/orchestra --plan`, `/orchestra --keys-status`.

## Flujo de publicación

```bash
# cambios en este repo
node orchestra.mjs --self-test
git add -A && git commit -m "feat: ..."
git tag -a v0.3.0 -m "..."
git push origin main --tags
# en cada PC
pi update --extensions
```
