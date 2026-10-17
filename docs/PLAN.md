
# SentinelOps AI — Plan de implementación

## 1. Información general


- **Proyecto:** SentinelOps AI
- **Objetivo:** construir una plataforma de investigación y diagnóstico de incidentes de software mediante RAG, herramientas MCP, workflows de IA y mecanismos de verificación.
- **Estado actual:** planificación e inspección inicial.
- **Repositorio:** https://github.com/dantuki/SENTINELOPS-AI
- **Rama inicial:** `main`


Este documento define las fases de trabajo, los entregables y los criterios que deben cumplirse antes de considerar terminada una fase.

Los estados y resultados se actualizarán únicamente cuando exista evidencia del trabajo realizado.

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
