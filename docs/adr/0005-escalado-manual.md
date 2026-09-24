# ADR 0005 — El escalado a modelos caros es manual

## Estado

Aceptado (2026-09-24).

## Contexto

`pickAuthorVerifier` usaba el par de escalado (`escalationAuthor` / `escalationVerifier`)
**automáticamente** en el último ciclo (`cycle === maxCycles`). En una corrida real
(`htr-corpus-exporter`, 3 ciclos, fallida) el escalado se llevó **1,06 de 1,45 USD** y no
cambió el veredicto: el run igual falló. En un esquema donde **el orquestador es el chat**,
gastar el par caro "por si acaso" contradice el objetivo de ahorrar tokens caros.

## Decisión

El escalado automático queda **deshabilitado por defecto**. Sólo se usa el par de escalado si:

- `loop.autoEscalate: true` en `config.json` (opt-in por proyecto), o
- el chat **fuerza** un modelo (`forced.author` / `forced.verifier`, p. ej. vía una decisión
  de estancamiento `escalate`).

## Consecuencias

- El último ciclo usa la rotación normal de modelos baratos.
- Para escalar en un caso puntual, el chat lo pide explícitamente, o se setea `autoEscalate`
  para ese proyecto.
- Tests que cubren ambos caminos: `pickAuthorVerifier no escala solo (default)` y
  `pickAuthorVerifier escala si autoEscalate`.
- `autoEscalate` se documenta en `templates/config.json`.
