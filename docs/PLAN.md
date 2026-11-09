
# SentinelOps AI — Plan de implementación

## 1. Información general


- **Proyecto:** SentinelOps AI
- **Objetivo:** construir una plataforma de investigación y diagnóstico de incidentes de software mediante RAG, herramientas MCP, workflows de IA y mecanismos de verificación.
- **Estado actual:** Phase 3.1 implementada parcialmente y bloqueada por la puerta de aceptación.
- **Repositorio:** https://github.com/dantuki/SENTINELOPS-AI
- **Rama inicial:** `main`


Este documento define las fases de trabajo, los entregables y los criterios que deben cumplirse antes de considerar terminada una fase.

Los estados y resultados se actualizarán únicamente cuando exista evidencia del trabajo realizado.

## Estado de ejecución actualizado — 3 de noviembre de 2026

**PHASE 3.1: BLOCKED.** PostgreSQL y pgvector reales estuvieron disponibles; el runner registró las migraciones 001–004 detectadas por sus firmas y aplicó 005–006. Los conteos de datos existentes se conservaron durante las migraciones. La importación real de INC-001 indexó dos documentos y la repetición no creó chunks ni embeddings duplicados.

La prueba de aislamiento pasó en una base PostgreSQL separada con datos sintéticos; la base original contiene un solo proyecto y no se modificó para sembrar otro. Una evaluación factual de solo lectura recuperó todas las observaciones, pero la respuesta cubrió solo 1/6 y afirmó una causa raíz no demostrada. La latencia de esa investigación fue 11.5 segundos y los conteos de la base original permanecieron iguales. No se cumplen todos los criterios de aceptación.

**Phase 4 no ha comenzado.** No iniciar Evaluation Engine, Observability Engine ni dashboards hasta que Phase 3.1 supere la puerta de aceptación con pruebas reproducibles. La matriz de estado detallada y los comandos ejecutados están en `docs/TEST-PLAN.md`.

### Estado de implementación — Reliability Gate

Se incorporó en el código un contrato JSON para la investigación, con hechos, hipótesis tipadas, información faltante, comprobaciones y limitaciones. La API valida el esquema y que las referencias correspondan a evidencia recuperada, aplica reglas deterministas de factualidad y se abstiene cuando no hay evidencia suficiente; el orquestador envía a Ollama el esquema estructurado proporcionado por la API, que sigue siendo responsable de la validación final. Los diagnósticos internos de contrato contienen rutas y códigos acotados, no el texto generado, y la respuesta pública conserva un error genérico.

En una validación anterior pasaron 115 pruebas de Product API, 33 pruebas del AI Orchestrator y los typechecks de API y runner. El runner PostgreSQL también terminó correctamente en esa validación (migraciones 001–007 idempotentes, 2 pruebas aprobadas, 0 fallidas) dentro de un contenedor temporal eliminado al terminar. El runner recibió después cambios de ciclo de vida; desde esos cambios solo se han ejecutado pruebas unitarias y typechecks, no el runner PostgreSQL real. El runner de INC-001 registra la etapa de fallo y solo declara verificado el cleanup al confirmar el estado de procesos y recursos temporales. La evaluación real de INC-001 no se ejecutó; por tanto, el gate sigue bloqueado y no se declara aprobado.

La validación correctiva local pasó 130 pruebas de Product API, 34 pruebas de Orchestrator y los typechecks de API y web; también pasó el typecheck explícito de los runners y sus helpers. El runner INC-001 recalcula las métricas declaradas desde la respuesta y las evidencias capturadas antes de aceptar un reporte. Los runners conservan la primera señal, revisan interrupciones durante etapas de arranque y notifican recursos temporales persistentes sin afirmar una limpieza no verificada. Estas comprobaciones fueron unitarias y simuladas; la integración del runner PostgreSQL y la evaluación INC-001 permanecieron pendientes.

La implementación actual añade una traza PostgreSQL vinculada al mismo run/request, verificación de bytes y lineage contra la base temporal, mapeo determinista de claims/citas y un gate final que también exige cleanup verificado. La validación local más reciente pasó 132 pruebas de Product API, el typecheck y build de API. El preflight de solo lectura encontró Ollama y ambos nombres de modelo, pero Docker/el contenedor pgvector local no estaban disponibles y faltaba el entorno virtual del orquestador. No se aplicó la migración 008 ni se ejecutaron servicios, inferencias o INC-001; por tanto, la evaluación y el Reliability Gate siguen bloqueados para validación integrada.

## 2. Estado inicial verificado

Durante la inspección inicial se observó lo siguiente:

- El repositorio está clonado localmente.
- La rama activa es `main`.
- El repositorio remoto `origin` apunta a `dantuki/SENTINELOPS-AI`.
- El commit inicial observado es `58fbda3`.
- El único archivo registrado por Git al iniciar la inspección es `README.md`.
- El README inicial contiene únicamente el título del proyecto.
- `git status --short --branch` mostró `main...origin/main`, sin cambios locales pendientes.
- El entorno local utiliza Windows y CMD.

Versiones observadas en el entorno local:

| Herramienta | Versión observada |
|---|---|
| Node.js | 24.13.0 |
| npm | 11.6.2 |
| Python | 3.14.3 |
| Docker | 28.4.0 |
| Docker Compose | v2.39.4-desktop.1 |

Estas versiones describen el entorno observado. No significan que todos los servicios o las dependencias del proyecto ya estén instalados o probados.

## 3. Principios de implementación

1. Implementar cambios pequeños, verificables y documentados.
2. Inspeccionar los archivos existentes antes de modificarlos.
3. Validar las dependencias y sus versiones contra la documentación oficial.
4. No inventar resultados de pruebas, métricas, integraciones ni diagnósticos.
5. Mantener separados los proyectos y los permisos de cada workspace.
6. Tratar los documentos recuperados como contenido no confiable.
7. Aplicar controles de autorización mediante código, no únicamente mediante instrucciones al modelo.
8. Permitir la abstención cuando no haya evidencia suficiente.
9. No ejecutar cambios destructivos ni acciones sobre producción.
10. Mantener secretos fuera del repositorio, las imágenes, el frontend y los logs.
11. Registrar decisiones arquitectónicas y alternativas consideradas.
12. No dar por terminada una fase sin comprobar sus criterios de aceptación.

## 4. Dirección arquitectónica inicial

La propuesta de arquitectura, pendiente de validación definitiva, contempla:

- `apps/web`: interfaz de usuario con Next.js, React y TypeScript.
- `apps/api`: API de producto con Node.js, TypeScript y Fastify.
- `services/ai-orchestrator`: motor de IA con Python, FastAPI, Pydantic y LangGraph cuando resulte apropiado.
- `services/mcp-server`: servidor MCP independiente implementado con el SDK oficial de TypeScript.
- `packages/shared-contracts`: contratos y esquemas compartidos por los componentes TypeScript.
- `infra`: configuración de infraestructura y migraciones.
- `datasets`: datos sintéticos de demostración y evaluación.
- `docs`: arquitectura, plan, decisiones técnicas, seguridad y operación.
- `tests`: pruebas adicionales de integración y extremo a extremo.

La persistencia principal será PostgreSQL con pgvector.

Redis y BullMQ se incorporarán si la implementación justifica una cola de trabajos con reintentos, procesamiento asíncrono y estados duraderos.

Docker Compose será la base para el entorno local y el despliegue inicial en un VPS Linux.

La arquitectura final, las dependencias y los límites de responsabilidad se documentarán en `docs/ARCHITECTURE.md` y en los ADR correspondientes.

## 5. Fases e hitos

### Fase 0 — Inspección y diseño

**Estado:** en curso.

Entregables:

- [ ] Inspección del entorno de desarrollo.
- [ ] Verificación del estado inicial del repositorio.
- [ ] `docs/PLAN.md`.
- [ ] `docs/ARCHITECTURE.md`.
- [ ] ADRs de decisiones arquitectónicas.
- [ ] Criterios de aceptación y estrategia de pruebas.
- [ ] Diseño inicial de seguridad y despliegue.
- [ ] Registro de dependencias y compatibilidades que requieren validación.

Criterio de salida:

La arquitectura, sus principales decisiones, sus riesgos y el plan de implementación están documentados y revisados. Las incertidumbres quedan identificadas.

### Fase 1 — Fundación ejecutable

Entregables:

- Monorepo y configuración reproducible.
- Entorno Docker Compose.
- PostgreSQL y migraciones iniciales.
- Aplicación Next.js.
- API Fastify.
- Servicio de IA con FastAPI.
- Esqueleto funcional del servidor MCP.
- Health checks.
- Autenticación y autorización básicas.
- Pruebas iniciales y CI.

Criterio de salida:

Los servicios definidos para esta fase arrancan, sus health checks funcionan y las comunicaciones necesarias han sido verificadas.

### Fase 2 — RAG funcional

Entregables:

- Ingestión documental.
- Extracción y normalización.
- Fragmentación con metadatos.
- Generación y persistencia de embeddings.
- Búsqueda vectorial y léxica.
- Recuperación híbrida.
- Re-ranking cuando aporte valor.
- Filtrado por proyecto y permisos.
- Citas verificables.
- Pruebas de recuperación.

Criterio de salida:

Una consulta sobre fuentes indexadas produce resultados recuperados que se pueden verificar contra los documentos originales.

### Fase 3 — MCP funcional

Entregables:

- Servidor MCP independiente.
- Herramientas de lectura.
- Esquemas estrictos de entrada y salida.
- Cliente MCP dentro del flujo de investigación.
- Autorización por proyecto.
- Timeouts y límites de ejecución.
- Auditoría e integración probada.

Criterio de salida:

Un cliente MCP compatible invoca herramientas autorizadas y el orquestador utiliza sus resultados reales.

### Fase 4 — Orquestación agéntica

Entregables:

- Workflow con estado explícito.
- Clasificación del incidente.
- Recuperación de evidencias.
- Investigación de hipótesis.
- Plan de remediación.
- Verificación de conclusiones.
- Condiciones de parada y abstención.
- Límites de recursos e iteraciones.
- Trazabilidad entre etapas.

Criterio de salida:

Un incidente reproducible genera un informe estructurado que distingue hechos, hipótesis, incertidumbres y acciones recomendadas.

### Fase 5 — Seguridad y evaluación

Entregables:

- Guardrails de entrada, herramientas y salida.
- Pruebas de prompt injection.
- Aislamiento entre proyectos.
- Dataset de evaluación.
- Métricas de retrieval y fundamentación.
- Casos de abstención.
- Trazas y métricas operativas.
- Pruebas adversariales reproducibles.

Criterio de salida:

Las evaluaciones producen resultados calculados, los fallos son observables y los controles definidos cuentan con pruebas concretas.

### Fase 6 — Interfaz completa

Entregables:

- Dashboard.
- Gestión de proyectos y fuentes.
- Gestión de incidentes.
- Espacio de investigación.
- Visualización de evidencias y citas.
- Trazas de ejecución.
- Evaluaciones.
- Configuración.
- Estados de carga, error, vacío y resultado parcial.

Criterio de salida:

El flujo principal se puede recorrer desde la interfaz, conectado a los servicios reales, sin depender de botones decorativos o datos ficticios no identificados.

### Fase 7 — Calidad y entrega

Entregables:

- Suite de pruebas.
- Lint y comprobaciones de tipos.
- CI.
- Revisión de dependencias y vulnerabilidades.
- Instalación reproducible desde cero.
- Documentación completa.
- Dataset de demostración.
- Guía de despliegue en VPS Linux.
- Backups y restauración probados.
- Procedimiento de actualización y rollback.
- Lista de comprobación de seguridad.

Criterio de salida:

Otra persona puede seguir la documentación, ejecutar el sistema, probar el flujo principal y revisar los resultados de las verificaciones realizadas.

## 6. Estrategia de pruebas

Se implementarán pruebas en diferentes niveles:

- **Unitarias:** validaciones, lógica de negocio, fragmentación, permisos y métricas.
- **Integración:** persistencia, RAG, herramientas MCP, proveedores y orquestación.
- **Extremo a extremo:** recorridos de usuario desde la interfaz hasta el resultado.
- **Seguridad:** acceso cruzado, entradas maliciosas, límites de archivos, secretos y permisos.
- **Evaluación de IA:** recuperación, referencias, diagnósticos, herramientas, abstención y ataques del benchmark.
- **Infraestructura:** health checks, instalación, backups, restauración y despliegue.

Los tests que requieren servicios externos estarán identificados y separados de las pruebas locales ordinarias.

Cada resultado debe reflejar lo que realmente se ejecutó. Una prueba pendiente no se marcará como exitosa.

## 7. Riesgos y decisiones pendientes

Antes de fijar la configuración definitiva debemos validar:

- Versiones compatibles de las dependencias.
- Versión de Python para el entorno de ejecución de IA.
- SDK y transporte MCP adecuados.
- Proveedor de embeddings.
- Proveedores de modelos locales y remotos.
- Estrategia de autenticación y sesiones.
- Elección del proxy inverso.
- Necesidad real de Redis y BullMQ.
- Límites de carga y almacenamiento documental.
- Requisitos de recursos para el VPS.
- Costos, latencia y privacidad de los proveedores de modelos.

No se seleccionará un VPS ni un presupuesto sin conocer las necesidades y comparar alternativas.

## 8. Proceso para cerrar un hito

Antes de avanzar al siguiente hito se debe registrar:

1. Objetivo y alcance.
2. Archivos creados o modificados.
3. Decisiones y alternativas relevantes.
4. Comandos ejecutados.
5. Resultados reales de las pruebas.
6. Errores y riesgos pendientes.
7. Criterios de aceptación satisfechos o pendientes.

## 9. Estado actual

- Repositorio inspeccionado inicialmente: sí.
- Aplicación implementada: no.
- Dependencias del producto instaladas: no verificadas.
- Servicios Docker del proyecto: todavía no creados ni probados.
- Fase 0: en curso.
- Siguiente entregable: `docs/ARCHITECTURE.md`.
# Evidence provenance increment — implemented code, NOT_VERIFIED against infrastructure

Additive migration `008_add_retrieval_trace.sql` defines retrieval-event headers and ordered items with project, document, and source lineage constraints. The Product API persists the trace before invoking the model; the isolated evaluator reads it back through its temporary database pool and recomputes the final report. API tests exercise mocked persistence, trace verification, metric integrity, and cleanup gating. Migration 008, the PostgreSQL runner, Ollama inference, and the complete INC-001 RAG evaluation have not been run in the current validation; do not treat the implementation or mock results as a closed gate.
