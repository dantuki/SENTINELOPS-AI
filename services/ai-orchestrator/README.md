
# SentinelOps AI Orchestrator

Servicio de IA de SentinelOps AI construido con FastAPI. Actualmente permite generar respuestas mediante un modelo de lenguaje local ejecutado con Ollama.

## Requisitos

- Python 3.13.
- `uv` para gestionar las dependencias de Python.
- Ollama instalado y en ejecución.
- El modelo local `qwen3.5:4b` descargado.

## Instalación

Desde la raíz del repositorio, entra en el directorio del servicio:

```cmd
cd services\ai-orchestrator
```

Sincroniza las dependencias:

```cmd
uv sync --dev
```

Descarga el modelo de Ollama:

```cmd
ollama pull qwen3.5:4b
```

Asegúrate de que Ollama esté ejecutándose antes de probar el chat.

## Ejecución

Desde el directorio `services\ai-orchestrator`, inicia el servidor:

```cmd
uv run uvicorn sentinelops_ai_orchestrator.app:app --app-dir src --host 127.0.0.1 --port 8001
```

Mantén esa terminal abierta mientras utilizas el servicio.

## Verificación

En otra ventana de CMD, comprueba el estado del servicio:

```cmd
curl http://127.0.0.1:8001/health
```

Para probar una generación mediante el modelo local:

```cmd
curl --max-time 90 -sS http://127.0.0.1:8001/chat -H "Content-Type: application/json" -d "{\"prompt\":\"Responde en español y brevemente: ¿qué revisarías primero ante un error HTTP 503?\"}"
```

## Pruebas automatizadas

Desde el directorio `services\ai-orchestrator`, ejecuta:

```cmd
uv run pytest
```

## Notas

- El servicio utiliza Ollama para la generación local de respuestas.
- El modelo debe estar instalado y disponible en Ollama.
- La disponibilidad del endpoint de salud no garantiza por sí sola que la generación de respuestas funcione.
- Las causas raíz de los incidentes deben validarse con evidencias; una respuesta generada por el modelo no constituye por sí sola una confirmación.
