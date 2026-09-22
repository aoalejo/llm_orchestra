---
description: Ciclo Ralph con verificación adversa y ciclado de modelos
---
Ejecutá un ciclo del Lean Orchestrator para la tarea `$ARGUMENTS`.

1. Leé `.orchestra/STATE.md` y `.orchestra/tasks.json`.
2. Identificá el work order de la tarea y confirmá su scope y acceptance criteria.
3. Despachá al autor (modelo barato rotado) con el work order acotado.
4. Corré el gate determinista de los `targets`.
5. Despachá al verificador adversario con un modelo **distinto** al autor.
6. Si el gate está verde y `verdict: PASS` sin findings `high` → pedile al orquestador
   la aprobación final y el mensaje de commit.
7. Si no, rotá modelos y repetí el ciclo (máx. `loop.maxCycles`).

No commitees vos. El commit lo ejecuta el driver en nombre del orquestador.
