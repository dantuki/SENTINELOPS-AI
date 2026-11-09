# SentinelOps AI

## Evidence provenance (implemented, pending infrastructure validation)

Investigations persist a Retrieval Trace before chunks are sent to the AI service. A trace binds a server-generated request UUID, a runner correlation UUID, project, requested incident, rank, canonical chunk/document/source lineage, retrieval score, SHA-256 of the exact UTF-8 chunk content, and scope (`incident_specific`, `project_context`, `other_incident`, or `unknown_scope`). `E<n>` is only a stable per-request alias; the canonical evidence identity remains the chunk UUID.

The isolated evaluator must use `RetrievalTraceVerifier` with its temporary PostgreSQL pool to re-read the trace and lineage with parameterized read-only SQL. SHA-256 establishes equality of compared bytes, not authenticity by itself. A trace persistence failure returns an error rather than a response presented as provenance-verifiable. PostgreSQL/Ollama/INC-001 end-to-end validation has not been performed by this change; neither Reliability Gate nor RAG Evaluation Gate is closed.

### Inteligencia artificial local para la investigación y el diagnóstico de incidentes de software

SentinelOps AI es un proyecto de ingeniería de inteligencia artificial enfocado en investigar y diagnosticar incidentes de software mediante análisis basado en evidencias, aprendizaje automático local, generación aumentada por recuperación (RAG), Model Context Protocol (MCP) y flujos de trabajo agénticos controlados.

El objetivo es construir un sistema especializado que ayude a los desarrolladores a comprender fallos de software conectando reportes de incidentes con documentación técnica, código fuente, contratos de API y registros de eventos.

En lugar de generar explicaciones aparentemente convincentes sin verificarlas, SentinelOps busca diferenciar los hechos observados de las hipótesis, identificar información faltante, validar referencias y recomendar pruebas que permitan confirmar o descartar posibles causas raíz.

**Estado del proyecto:** En desarrollo activo. Phase 3.1 permanece bloqueada; Phase 4 no ha comenzado.

**Objetivo principal:** Construir y evaluar un sistema de inteligencia artificial especializado que pueda ejecutarse localmente sin requerir APIs de IA de pago para su funcionamiento principal.

**Repositorio:** [github.com/dantuki/SENTINELOPS-AI](https://github.com/dantuki/SENTINELOPS-AI)

---

## Tabla de contenido

- [El problema](#el-problema)
- [Visión del proyecto](#visión-del-proyecto)
- [Principios de ingeniería](#principios-de-ingeniería)
- [Arquitectura](#arquitectura)
- [Tecnologías](#tecnologías)
- [Implementación actual](#implementación-actual)
- [Estrategia de IA local](#estrategia-de-ia-local)
- [Flujo de investigación previsto](#flujo-de-investigación-previsto)
- [Seguridad y confiabilidad](#seguridad-y-confiabilidad)
- [Pruebas y evaluación](#pruebas-y-evaluación)
- [Configuración del entorno de desarrollo](#configuración-del-entorno-de-desarrollo)
- [Hoja de ruta](#hoja-de-ruta)
- [Limitaciones del proyecto](#limitaciones-del-proyecto)
- [Licencia](#licencia)

## El problema

La investigación de un incidente de software puede requerir que los desarrolladores examinen múltiples fuentes de información:

- Registros de aplicación y mensajes de error.
- Cambios recientes en el código.
- Especificaciones de API.
- Documentación técnica.
- Comportamiento de las bases de datos.
- Dependencias entre servicios.
- Incidentes anteriores y notas de diagnóstico.

Relacionar manualmente estas fuentes puede consumir tiempo, especialmente cuando la evidencia disponible es incompleta o contradictoria.

Un asistente convencional de inteligencia artificial puede generar una explicación convincente sin acceder al código relevante, sin verificar sus afirmaciones o sin diferenciar una hipótesis plausible de una causa raíz confirmada.

SentinelOps AI busca abordar este problema mediante investigaciones estructuradas, recuperación autorizada de evidencias, inteligencia local y verificación explícita.

## Visión del proyecto

El objetivo a largo plazo es construir una plataforma especializada de ingeniería de inteligencia artificial que permita:

1. Clasificar incidentes mediante un modelo de aprendizaje automático entrenado con un conjunto de datos específico del proyecto.
2. Ingerir e indexar documentación técnica, código fuente, contratos de API y registros.
3. Recuperar evidencias relevantes mediante búsqueda vectorial y léxica.
4. Invocar herramientas de investigación autorizadas a través de un servidor MCP real.
5. Analizar hipótesis alternativas sobre las causas raíz.
6. Identificar contradicciones y contexto faltante.
7. Generar planes estructurados de corrección y pruebas de regresión.
8. Verificar las referencias antes de presentar conclusiones.
9. Abstenerse cuando la evidencia disponible no sea suficiente.
10. Registrar las investigaciones y permitir evaluaciones reproducibles.

La plataforma está pensada para trabajar inicialmente con fuentes de proyectos autorizadas y datos sintéticos de demostración. El diseño inicial no permite realizar automáticamente cambios en sistemas de producción.

## Principios de ingeniería

### La evidencia antes que las suposiciones

Una hipótesis no debe presentarse como una causa raíz confirmada simplemente porque parezca plausible. Los hallazgos deben vincularse a fuentes verificables cuando corresponda.

### Inteligencia local como prioridad

El sistema está diseñado para utilizar modelos ejecutados localmente y embeddings generados localmente. Las APIs de inferencia de pago no deben ser un requisito para la demostración local prevista.

### Aprendizaje automático transparente

El proyecto distingue entre entrenar un modelo, adaptar un modelo existente, recuperar documentos mediante RAG y orquestar un flujo de trabajo. Son técnicas diferentes y deben documentarse como tales.

### Seguridad desde el diseño

El aislamiento entre proyectos, las herramientas restringidas, la validación estricta, la defensa frente a prompt injection y el tratamiento seguro de contenido no confiable son requisitos esenciales.

### Evaluación reproducible

Las afirmaciones sobre calidad y rendimiento deben apoyarse en pruebas ejecutadas y resultados medidos. Los tests con mocks, los datos sintéticos, las pruebas con modelos locales reales y las pruebas con proveedores externos deben identificarse por separado.

## Arquitectura

El repositorio utiliza un monorepo que separa la interfaz del producto, la API del backend, el orquestador de inteligencia artificial y la infraestructura.

```mermaid
flowchart TD
    U[Desarrollador o analista] --> W[Aplicación web Next.js]
    W --> A[API de producto Fastify]
    A --> DB[(PostgreSQL y pgvector)]
    A --> AI[Orquestador de IA en Python]
    AI --> C[Clasificador de incidentes]
    AI --> R[Pipeline de recuperación RAG]
    R --> DB
    AI --> M[Cliente MCP]
    M --> MCP[Servidor MCP independiente]
    MCP --> S[Fuentes autorizadas del proyecto]
    AI --> L[Modelo generativo local]
    AI --> V[Verificación de evidencias y resultados]
    V --> A
    A --> W
```

**Importante:** este diagrama representa la arquitectura objetivo. No todos los componentes ni todas las conexiones que aparecen están implementados o verificados en el estado actual del repositorio.

### Responsabilidades de los componentes

| Componente | Responsabilidad |
|---|---|
| `apps/web` | Interfaz web construida con Next.js, React y TypeScript. |
| `apps/api` | API de producto desarrollada con Node.js, TypeScript y Fastify. |
| `services/ai-orchestrator` | Servicio Python para el procesamiento de IA y los futuros flujos de investigación. |
| `services/mcp-server` | Ubicación prevista para la implementación independiente del servidor MCP. |
| `packages/shared-contracts` | Contratos compartidos entre los componentes TypeScript. |
| `packages/config` | Configuración compartida del proyecto. |
| `infra/migrations` | Migraciones versionadas del esquema PostgreSQL. |
| `docs` | Documentación de arquitectura, seguridad, pruebas, implementación y decisiones técnicas. |

PostgreSQL proporciona persistencia relacional, mientras que pgvector permite realizar búsquedas vectoriales. La estrategia de recuperación definitiva busca combinar la búsqueda semántica y la léxica, en lugar de depender exclusivamente de la similitud vectorial.

## Tecnologías

| Área | Tecnología |
|---|---|
| Frontend | Next.js, React, TypeScript y Tailwind CSS |
| API de producto | Node.js, TypeScript y Fastify |
| Servicio de IA | Python, FastAPI y Pydantic |
| Orquestación de workflows | LangGraph, cuando aporte valor al flujo implementado |
| Base de datos | PostgreSQL |
| Recuperación vectorial | pgvector |
| Interoperabilidad con herramientas | Model Context Protocol (MCP) |
| Ejecución de modelos locales | Ollama u otro runtime local validado |
| Embeddings locales | Modelo de embeddings compatible ejecutado localmente |
| Infraestructura | Docker Compose |
| Pruebas | Herramientas de pruebas de Node.js, pytest y pruebas de integración |

Las tecnologías anteriores describen el stack existente y las decisiones previstas. Su inclusión no significa que todas las integraciones estén funcionando actualmente.

## Implementación actual

El repositorio ya cuenta con una base sobre la que continuar el desarrollo.

| Área | Estado actual |
|---|---|
| Estructura del monorepo | Presente |
| Interfaz Next.js | Incluye el espacio de investigación y la Knowledge Base; el flujo E2E sigue pendiente de validar |
| API Fastify | Incluye API de producto, ingestión documental, embeddings, búsqueda e investigación |
| PostgreSQL | Integración local verificada en una ejecución anterior; los cambios recientes al ciclo de vida del runner esperan una nueva integración |
| pgvector | PostgreSQL 18.6 y pgvector 0.8.7 verificados en la ejecución local del 3 de noviembre de 2026 |
| Fuentes, documentos y fragmentos | Ingesta real de INC-001, embeddings persistidos y repetición idempotente comprobadas localmente |
| Embeddings locales | El orquestador usa Ollama con `qwen3-embedding:0.6b` y vectores de 1024 dimensiones |
| Generación local | El orquestador usa Ollama con `qwen3.5:4b` |
| Búsqueda semántica | Recupera fragmentos indexados de fuentes activas, con filtros por proyecto e incidente |
| Importación de INC-001 | Los dos archivos allowlisted se indexaron; reintentar no creó chunks ni embeddings duplicados |
| Investigación E2E con persistencia real | La búsqueda recupera evidencia, pero la última evaluación factual no alcanzó la cobertura requerida |
| Readiness del orquestador | `/health` es liveness; `/ready` comprueba que los dos modelos requeridos estén cargados |
| Fundamentos de autenticación | Fase Security Foundation implementada en código; integración de aislamiento aprobada anteriormente; despliegue pendiente |
| Contrato de investigación | API y orquestador se comprueban contra un JSON Schema compartido; la API valida citas y factualidad, y la UI mantiene una validación de presentación |
| Integración de seguridad PostgreSQL | En una ejecución anterior, el runner desechable y sus suites terminaron correctamente (2 pruebas aprobadas, 0 fallidas); tras el hardening actual del ciclo de vida, el runner real aún debe repetirse |
| Evaluación factual determinista | Incluye nueve reglas de factualidad para INC-001; no sustituye un benchmark completo |
| Clasificador de incidentes entrenado | Planeado |
| Servidor MCP independiente | Implementación y pruebas de protocolo pendientes de verificación |
| Evaluation y Observability Engines de Phase 4 | No iniciados: la puerta de aceptación de Phase 3.1 sigue bloqueada |
| Despliegue de producción | No implementado ni validado |

### Resultado de validación de Phase 3.1

**PHASE 3.1: BLOCKED.** En la ejecución local del 3 de noviembre de 2026:

- PostgreSQL y pgvector estaban saludables. Se registraron las migraciones 001–004 ya presentes y se aplicaron 005–006. Los conteos de datos existentes no cambiaron durante las migraciones.
- La ingesta real creó dos documentos indexados para INC-001; una segunda importación devolvió ambos como deduplicados y creó cero chunks y embeddings nuevos.
- La prueba de aislamiento pasó en una base PostgreSQL aislada con fixtures sintéticos. La base original contiene un solo proyecto, así que no se modificó para sembrar un segundo proyecto.
- La evaluación factual en modo de solo lectura (`--skip-ingestion`) recuperó todas las observaciones esperadas y mantuvo los conteos de la base original: 1 workspace, 1 proyecto, 2 incidentes, 3 fuentes, 5 documentos, 5 fragmentos y 5 embeddings.
- La respuesta real más reciente tardó 11.5 segundos, pero solo cubrió 1/6 observaciones y afirmó una causa raíz no demostrada. Por tanto, la aceptación factual sigue bloqueada. En mediciones locales recientes, la GPU llegó al 100 %, la VRAM usada alcanzó 5.6 GiB de 6 GiB y la RAM disponible bajó a 6.1 GiB; son picos puntuales, no un benchmark sostenido.
- Ollama informa explícitamente cuando una generación alcanza el límite de tokens; el AI Orchestrator rechaza esas salidas truncadas en lugar de devolverlas como respuestas completas.
- Las nueve reglas deterministas de factualidad cubren confusiones observadas en INC-001. El archivo `ground-truth/INC-001.expected.json` no forma parte de la lista de ingesta ni del contexto RAG.
- La aceptación continúa bloqueada por la cobertura insuficiente y la afirmación causal no respaldada; Phase 4 no ha comenzado.

No se declara aprobada la fase ni se inicia Phase 4 hasta cerrar estos puntos con pruebas reproducibles. Los umbrales de similitud por incidente son experimentales y no representan confianza causal.

El runner aislado ahora conserva en su reporte las evidencias recuperadas y el contenido de respuesta que sustentan las métricas. Antes de aceptar el resultado, vuelve a calcular recuperación, cobertura, citas, factualidad y filtración de referencia desde esos datos; discrepancias invalidan el reporte y no pueden producir un `PASS`. Esta verificación es determinista y depende de las reglas de evaluación de INC-001, no constituye una prueba semántica general.

Los runners registran señales repetidas conservando la primera interrupción, comprueban puntos de cancelación durante el arranque y esperan a completar la limpieza. El runner PostgreSQL limita el tiempo de cada proceso auxiliar; si un contenedor o volumen anónimo persiste, informa su estado e identidad y no intenta una segunda eliminación manual del volumen.

En la validación correctiva local pasaron 130 pruebas de Product API, 34 del AI Orchestrator y los typechecks de API, web y runners. Las pruebas nuevas cubren reportes con métricas fabricadas, respuestas sin observaciones, evidencias no relacionadas, filtración de ground truth, interrupciones simuladas, parada concurrente de procesos y recursos Docker persistentes simulados. No se ejecutaron Docker, PostgreSQL, migraciones, runners reales, Ollama ni la evaluación RAG; la limpieza integrada y la calidad de la respuesta real de INC-001 siguen pendientes.

Los resultados de pruebas con mocks y las mediciones de una ejecución local no garantizan la disponibilidad ni el rendimiento de otros entornos.

## Estrategia de IA local

El proyecto se desarrolla con una restricción clara: **el flujo principal de IA debe poder ejecutarse localmente sin necesitar APIs de inteligencia artificial de pago ni servicios externos de inferencia**.

La arquitectura de IA prevista cuenta con tres componentes complementarios.

### 1. Un modelo de aprendizaje automático especializado en incidentes

SentinelOps busca incorporar un clasificador entrenado con un conjunto de datos versionado de incidentes de software.

Entre las categorías posibles están los fallos de API, problemas de autenticación, errores de bases de datos, problemas de configuración, regresiones, degradaciones del rendimiento e incidentes con evidencia insuficiente.

Primero se evaluará una solución local sencilla, como TF-IDF con regresión logística u otro clasificador adecuado.

El proceso de entrenamiento debe ser reproducible e incluir datos de prueba independientes, métricas por categoría, una matriz de confusión y artefactos del modelo persistidos.

### 2. Un modelo generativo ejecutado localmente

Se seleccionará un modelo de pesos abiertos después de evaluar el hardware disponible, la memoria, el almacenamiento, el rendimiento de inferencia, el soporte de idiomas y la licencia.

El modelo deberá analizar evidencia técnica, comparar hipótesis, identificar información faltante y producir informes estructurados de investigación.

La inferencia se mantendrá local por defecto. Si el modelo local no está disponible, el sistema debe mostrar un error claro en lugar de cambiar automáticamente a un proveedor remoto de pago.

### 3. Embeddings locales y RAG

Los documentos técnicos, el código fuente, los contratos de API y los registros se procesarán e indexarán localmente.

La recuperación busca combinar:

- Similitud vectorial mediante pgvector.
- Búsqueda léxica o de texto completo.
- Combinación configurable y deduplicación de resultados.
- Filtrado por proyecto y permisos.
- Referencias verificables a las fuentes.
- Reordenamiento opcional cuando aporte una mejora medible.

La transición debe gestionar el esquema vectorial existente mediante migraciones controladas y no destructivas. Los embeddings de modelos incompatibles no deben mezclarse dentro del mismo espacio de recuperación.

### Evolución futura

Más adelante se podrá evaluar el ajuste fino mediante técnicas como LoRA o QLoRA, si el hardware, las licencias, los datos de entrenamiento y las mejoras medibles lo justifican.

SentinelOps no afirma entrenar un modelo fundacional de lenguaje desde pesos aleatorios. El objetivo es construir un sistema de IA especializado y propio mediante modelos locales, aprendizaje automático específico, recuperación documental, herramientas y evaluación rigurosa.

## Flujo de investigación previsto

El pipeline de investigación previsto es el siguiente:

```mermaid
flowchart TD
    I[Reporte del incidente] --> T[Clasificación inicial]
    T --> R[Recuperación de evidencias]
    R --> M[Invocación de herramientas MCP]
    M --> H[Investigación de hipótesis]
    H --> P[Planificación de correcciones]
    P --> V[Verificación de evidencias]
    V --> D{¿Hay evidencia suficiente?}
    D -->|Sí| F[Diagnóstico estructurado]
    D -->|No| A[Abstención o solicitud de contexto]
    F --> E[Persistir resultados y trazas]
    A --> E
```

Este flujo representa el diseño objetivo, no una afirmación de que todas las etapas estén funcionando actualmente.

El informe final de una investigación deberá incluir:

- Resumen y clasificación del incidente.
- Hechos observados.
- Referencias verificadas a las fuentes.
- Hipótesis alternativas.
- Evidencias que apoyan o contradicen cada hipótesis.
- Información faltante.
- Nivel de confianza y su justificación.
- Pruebas sugeridas para verificar las hipótesis.
- Plan de corrección recomendado.
- Pruebas de regresión.
- Resultados de verificación y limitaciones conocidas.

SentinelOps debe poder indicar: *«No hay evidencia suficiente para confirmar la causa raíz»*.

## Seguridad y confiabilidad

La seguridad es un requisito central porque el código, los documentos y los registros recuperados pueden contener instrucciones maliciosas o información engañosa.

Los controles previstos incluyen:

- Validación estricta de entradas y salidas.
- Acceso a documentos y herramientas limitado por proyecto.
- Protección contra accesos no autorizados entre proyectos.
- Herramientas de investigación restringidas y de solo lectura.
- Validación de rutas y protección frente a path traversal.
- Límites de tamaño, tiempos de espera y ejecución.
- Casos de prueba contra prompt injection.
- Validación de identificadores de fuentes y citas.
- Manejo seguro de errores y eliminación de secretos de los registros.
- Abstención explícita cuando la evidencia no sea suficiente.

La detección de prompt injection por sí sola no se considera una defensa suficiente. Los permisos, el aislamiento de datos, las restricciones de herramientas y la validación determinista deben imponerse desde la aplicación.

El sistema no se considerará seguro para producción únicamente por utilizar Docker, HTTPS o un modelo local. Los controles de seguridad deben verificarse mediante pruebas.

La configuración operativa de autenticación, sesiones, roles, bootstrap y límites pendientes se describe en [Fundamentos de autenticación y autorización](docs/SECURITY-FOUNDATION.md). Las decisiones de arquitectura correspondientes están registradas en [ADR-0005](docs/adr/0005-autenticacion-sesiones-y-rbac.md).

## Pruebas y evaluación

Las pruebas deben cubrir varios niveles:

- **Pruebas unitarias:** validación, reglas de negocio, lógica de clasificación, fragmentación y métricas.
- **Pruebas de integración:** PostgreSQL, embeddings locales, recuperación, MCP y componentes del workflow.
- **Pruebas de integración con modelos:** solicitudes reales de generación y embeddings a modelos locales instalados.
- **Pruebas de seguridad:** aislamiento de proyectos, documentos maliciosos, prompt injection y restricciones de herramientas.
- **Evaluación de IA:** métricas del clasificador, Recall@k, calidad del ranking, validez de las fuentes, calidad del diagnóstico, uso de herramientas y comportamiento de abstención.
- **Pruebas operativas:** latencia, errores, consumo de memoria e instalación reproducible.

Las pruebas de integración con modelos locales deben distinguirse de las pruebas con mocks. Que una prueba simulada termine correctamente no demuestra que un modelo real esté funcionando.

Los resultados de evaluación solo se publicarán después de ejecutar el benchmark correspondiente. Este README no afirma cifras de precisión ni de rendimiento.

## Configuración del entorno de desarrollo

### Requisitos previos

Antes de instalar dependencias, comprueba las versiones declaradas por el repositorio:

- Node.js y npm compatibles con el `package.json` de la raíz.
- Python compatible con `services/ai-orchestrator/pyproject.toml`.
- `uv` para gestionar el entorno y las dependencias de Python.
- Docker Desktop con Docker Compose.
- Espacio en disco y memoria suficientes para los modelos locales seleccionados.

Los requisitos declarados de Node.js y Python deben contrastarse con el entorno instalado antes de garantizar una instalación limpia.

### 1. Clonar el repositorio

```bash
git clone https://github.com/dantuki/SENTINELOPS-AI.git
cd SENTINELOPS-AI
```

### 2. Configurar el entorno local

En Windows CMD:

```cmd
copy .env.example .env
```

Edita `.env` localmente y configura los valores de PostgreSQL según las necesidades de tu entorno.

No subas `.env` al repositorio ni incluyas secretos en el código.

### 3. Instalar las dependencias de JavaScript

Después de comprobar que las versiones instaladas de Node.js y npm cumplen los requisitos del proyecto:

```bash
npm install
```

### 4. Iniciar PostgreSQL

Después de configurar `.env`:

```bash
docker compose up -d postgres
```

Comprueba el estado del contenedor:

```bash
docker compose ps
```

Aplica o verifica las migraciones con el runner transaccional:

```cmd
npm.cmd --prefix apps/api run migrate
```

En una base de datos existente, crea primero una copia de seguridad. El runner detecta las firmas de esquema legadas, registra checksums, aplica las migraciones pendientes en orden y es seguro de repetir. Las migraciones pueden abortar si detectan datos incompatibles o duplicados; revisa esos datos antes de volver a intentarlo. No borres datos para forzar la aplicación.

Comprueba PostgreSQL y pgvector usando las variables configuradas dentro del contenedor:

```powershell
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database(), version()"'
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT extversion FROM pg_extension WHERE extname = ''vector''"'
```

No utilices comandos que eliminen los volúmenes persistentes cuando necesites detener o reiniciar los servicios de desarrollo.

### 5. Ejecutar la API de producto

```bash
npm run dev --workspace=@sentinelops/api
```

La configuración de desarrollo actual utiliza el puerto `3001` por defecto.

### 6. Ejecutar la aplicación web

En otra terminal:

```bash
npm run dev --workspace=@sentinelops/web
```

La configuración actual de desarrollo utiliza el puerto `3000` por defecto.

### 7. Ejecutar el orquestador de IA

Utiliza versiones de Python y `uv` compatibles con la configuración del proyecto. Inicia Ollama y asegúrate de que estén disponibles los modelos `qwen3-embedding:0.6b` y `qwen3.5:4b`. El orquestador usa esos modelos locales para embeddings y chat:

```bash
uv run --project services/ai-orchestrator sentinelops-ai-orchestrator
```

Que el servicio arranque no verifica por sí solo la calidad de las respuestas ni la integración E2E con la API, la base de datos y la interfaz.

Comprueba que ambos modelos requeridos estén cargados antes de iniciar una evaluación:

```bash
curl --fail http://127.0.0.1:8000/ready
```

### Ejecutar Phase 3.1 para INC-001

Con PostgreSQL, Ollama, el AI Orchestrator y Product API en ejecución, obtén el UUID de un proyecto existente y ejecuta:

```powershell
npm.cmd --prefix apps/api run evaluate:inc001 -- <PROJECT_UUID>
```

El runner importa únicamente los archivos allowlisted, espera una investigación real a través de Product API y evalúa su respuesta contra `ground-truth/INC-001.expected.json` **después** de recibirla. El archivo de referencia nunca se envía al modelo ni al pipeline de ingesta. El comando devuelve código de salida distinto de cero cuando faltan observaciones, hay citas inválidas, se detecta una afirmación factual prohibida o falla un servicio. Esta evaluación puntual no incluye persistencia de ejecuciones ni constituye el Evaluation Engine de Phase 4.

Para repetir la investigación sin importar datos, añade `--skip-ingestion` después del UUID:

```powershell
npm.cmd --prefix apps/api run evaluate:inc001 -- <PROJECT_UUID> --skip-ingestion
```

Este modo realiza warm-up, readiness, búsqueda e investigación; no ejecuta la ingesta de demo.

Para comprobar la idempotencia, vuelve a ejecutar el comando o repite la llamada de importación de demo; los documentos indexados deben informar deduplicación y no crear chunks ni embeddings adicionales. Para verificar persistencia, reinicia Product API y el AI Orchestrator sin detener ni eliminar el volumen PostgreSQL y repite la investigación. No uses `docker compose down -v`.

### Ejecutar las pruebas

El repositorio incluye suites de pruebas para la API y el servicio Python. Ejecuta los comandos pertinentes después de comprobar la compatibilidad de las dependencias y el estado actual del proyecto.

Pruebas de la API:

```bash
npm test --workspace=@sentinelops/api
```

Comprobación de tipos de la API:

```bash
npm run typecheck --workspace=@sentinelops/api
```

Compilación de la API:

```bash
npm run build --workspace=@sentinelops/api
```

Comprobación de tipos y compilación de la aplicación web:

```bash
npm run typecheck --workspace=@sentinelops/web
npm run build --workspace=@sentinelops/web
```

Pruebas del orquestador Python:

```bash
uv run --project services/ai-orchestrator pytest services/ai-orchestrator/tests/test_app.py
```

Una suite de pruebas solo debe declararse satisfactoria después de ejecutar el comando correspondiente y comprobar el resultado.

## Hoja de ruta

| Fase | Objetivo | Estado |
|---|---|---|
| 1 | Base de la aplicación y persistencia | Parcialmente implementada; verificar el estado actual |
| 2 | Generación y embeddings con modelos locales | Implementados mediante Ollama; validar con modelos reales en cada entorno |
| 3 | Ingesta, RAG local y recuperación híbrida | Ingesta y búsqueda semántica implementadas; validación E2E y recuperación híbrida pendientes |
| 4 | Evaluation Engine, Observability Engine y dashboards | Bloqueada hasta que Phase 3.1 supere la puerta de aceptación |
| 5 | Implementación y pruebas del servidor MCP independiente | Planeado |
| 6 | Construcción del workflow de investigación de incidentes | Planeado |
| 7 | Seguridad completa, trazas y benchmarks | Planeado |
| 8 | Integración del flujo de investigación con la interfaz web | Planeado |
| 9 | Entrega reproducible y preparación para despliegue futuro | Planeado |
| 10 | Evaluación opcional del ajuste fino local | Trabajo futuro opcional |

Las fases pueden ajustarse después de inspeccionar y probar el código. La implementación debe preservar el trabajo existente y no debe declarar una fase como terminada únicamente porque existan archivos o interfaces.

## Limitaciones del proyecto

SentinelOps AI es un proyecto experimental de ingeniería que todavía está en desarrollo.

En esta etapa:

- El flujo completo de investigación de extremo a extremo no se ha verificado.
- Las integraciones del modelo local y los embeddings locales requieren implementación y pruebas.
- El servidor MCP independiente debe verificarse mediante interacciones reales del protocolo.
- El clasificador específico del proyecto y el benchmark son componentes planificados.
- El rendimiento de los modelos locales depende del hardware disponible y del modelo seleccionado.
- Una futura publicación requerirá verificar controles adicionales de autenticación, autorización, aislamiento, infraestructura, copias de seguridad y seguridad.

El proyecto está pensado para fuentes autorizadas y demostraciones controladas. No debe utilizarse para efectuar cambios autónomos en sistemas de producción.

## Licencia

Este repositorio todavía no tiene una licencia especificada. Hasta que se incorpore una licencia, no debe asumirse que la disponibilidad pública del código autoriza su redistribución o reutilización.

---

**SentinelOps AI — Evidencia antes que suposiciones.**
