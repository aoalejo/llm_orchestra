# Security Policy

Este es un repositorio **público**. Las credenciales nunca deben commitearse.

## Qué NO va en el repo

- API keys (opencode-go, OpenAI, Anthropic, etc.)
- Tokens de WhatsApp/Meta, Firebase, Mercado Pago
- Archivos `.env` reales
- Cualquier `auth.json`, keystore o certificado

## Dónde van las credenciales

En cada proyecto consumidor, `.orchestra/.env` (ignorado por `.gitignore`):

```
OPENCODE_GO_KEY_ORCHESTRATOR=...
OPENCODE_GO_KEYS=key1,key2   # una o más keys de worker
```

El driver las lee y las pasa por invocación con `pi --api-key`; nunca se escriben
en `STATE.md`, `tasks.json`, `ledger.jsonl` ni logs (el driver enmascara la key).

## Si se filtra una credencial

1. Rotala/invalidala en el proveedor de inmediato.
2. Purgá el historial: `git filter-repo --path .env --invert-paths`.
3. Fuerza el push y avisá a los colaboradores.

## Reportar

Abrí un issue privado o contactá al mantenedor. No publiques la key filtrada.
