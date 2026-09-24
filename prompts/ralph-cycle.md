---
description: "Ciclo Ralph con verificación adversa (modo chat: el orquestador sos vos)"
---
Despachá trabajo al Lean Orchestrator para `$ARGUMENTS`.

En este paquete el **orquestador es el chat** (vos). No hay un LLM de management
interno: vos decidís, aprobás y commiteás.

1. **Recon barato** (no gasta tu contexto):
   `orchestra scout --query "..." [--task <id>] [--scope a,b] --json`
2. **Ejecutar trabajo** (1..N work orders disjuntos, en paralelo):
   `orchestra dispatch --order '{"goal":"...","acceptance":["criterio"],"scope":["src/..."]}' \
      [--order '<otro>'] [--workers 4] --json`
   El driver corre autor → gate → verifier → rondas (rotando modelos baratos) y
   devuelve un **resumen compacto**: `status`, `findings`, `verdict`, `cost`, `diff`.
3. **Aprobar** (si `status: needs-approval`):
   `orchestra approve --task <id> --commit [--yes] [--message "..."]`
   o `orchestra reject --task <id> [--reason "..."]`.
4. **Decidir** (si `status: needs-decision`: cuota o estancamiento):
   reintentá con `--decisions '{"keys":"use_orchestrator"|"use_fallback_models"|"pause"}'`
   o `'{"stall":"escalate"|"park"|"continue"}'`.

Reglas: no commitees a mano (lo hace `approve --commit`), y pedí el diff sólo si
necesitás profundizar (`runs/<id>/cycle-N/diff.patch`).
