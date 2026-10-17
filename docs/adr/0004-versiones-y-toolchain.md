
# ADR-0004: Versiones base y herramientas de desarrollo

- **Estado:** Aceptado como línea base provisional, pendiente de validación integral.
- **Fecha:** 2026-10-17

## 1. Contexto

SentinelOps AI combina un frontend y una API en TypeScript, un motor de IA en Python, un servidor MCP independiente y una infraestructura basada en PostgreSQL y Docker Compose.

Las versiones deben elegirse teniendo en cuenta:

- Compatibilidad entre componentes.
- Soporte y mantenimiento de seguridad.
- Disponibilidad de dependencias.
- Reproducibilidad de las instalaciones.
- Compatibilidad con el entorno local de Windows.
- Compatibilidad con el despliegue posterior en Linux.

La instalación global de una herramienta no determina automáticamente la versión que utilizará el proyecto.


-
## 2. Runtime de Node.js

### Decisión provisional

Utilizar Node.js 24 LTS como versión objetivo del proyecto.

El entorno local observado utiliza Node.js 24.13.0 y npm 11.6.2. Por tanto, no es necesario cambiar de versión global en este momento.

La documentación oficial de Next.js establece un requisito mínimo de Node.js 20.9. Fastify 5 tiene su propia política de soporte y pruebas para las líneas de Node.js; la compatibilidad de la integración completa deberá comprobarse mediante la instalación, la ejecución y las pruebas del proyecto.

La versión exacta del runtime se fijará de forma reproducible para el entorno de desarrollo, los contenedores y CI. Las dependencias se resolverán con versiones compatibles y un lockfile versionado.

No se asumirá que la disponibilidad de una versión LTS garantiza por sí sola la compatibilidad de todas las dependencias.

Referencias:

- https://nodejs.org/en/about/previous-releases
- https://fastify.dev/docs/latest/Reference/LTS/
- https://nextjs.org/docs/app/getting-started/installation


## 3. Frontend y herramientas TypeScript

### Decisión provisional

- Next.js con App Router.
- React y TypeScript.
- Tailwind CSS según la instalación oficial vigente.
- npm como gestor inicial de paquetes.
- npm workspaces para el monorepo, si la configuración validada lo permite.
- `package-lock.json` para reproducir las instalaciones.

Las versiones concretas se registrarán cuando se inicialice la aplicación.

No se utilizarán versiones `latest` sin guardar un lockfile ni se copiarán configuraciones de tutoriales de versiones anteriores.

Referencia:

- https://nextjs.org/docs/app/getting-started/installation
- https://tailwindcss.com/docs/installation/framework-guides/nextjs

## 4. Fastify

### Decisión provisional

Utilizar la línea Fastify 5.x sobre el runtime de Node.js definido para el proyecto.

La versión exacta se verificará antes de instalarla y quedará registrada en los manifiestos y el lockfile.

Se probarán:

- Arranque del servicio.
- Validación de solicitudes y respuestas.
- Manejo de errores.
- Integración con OpenAPI.
- Pruebas automatizadas.
- Ejecución bajo el runtime fijado.

Referencia:

- https://fastify.dev/docs/latest/Reference/LTS/

## 5. Runtime de Python

### Decisión provisional

Utilizar la serie Python 3.14 y adoptar Python 3.14.8 como objetivo inicial del entorno.

El equipo de desarrollo utilizará un entorno aislado del Python global. Se evaluará `uv` para gestionar la versión del intérprete, las dependencias y el archivo `uv.lock`.

La versión observada globalmente es Python 3.14.3. No se modificará la instalación global en este hito.

Antes de aprobar el runtime se resolverán e instalarán las dependencias seleccionadas y se ejecutarán las pruebas disponibles.

Si una dependencia esencial no fuera compatible, se documentará el fallo y se evaluará otra versión estable de Python antes de continuar.

Se priorizará Pydantic v2 y no se basará la implementación nueva en Pydantic v1.

Referencias:

- https://www.python.org/downloads/release/python-3148/
- https://fastapi.tiangolo.com/release-notes/
- https://docs.langchain.com/oss/python/langgraph/install
- https://docs.astral.sh/uv/concepts/python-versions/

## 6. SDK de MCP

### Decisión provisional

Utilizar el SDK oficial de Model Context Protocol para TypeScript, línea v2.

Los paquetes principales previstos son:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/client`

La documentación consultada identifica la línea v2 como estable y registra la versión 2.3.1 en octubre de 2026.

La versión exacta y sus requisitos se comprobarán en la instalación.

No se sustituirá la implementación del protocolo por funciones locales con nombres de herramientas.

Se probará la comunicación real entre el cliente y el servidor MCP.

Referencias:

- https://github.com/modelcontextprotocol/typescript-sdk
- https://github.com/modelcontextprotocol/typescript-sdk/releases
- https://ts.sdk.modelcontextprotocol.io/v2/

## 7. Persistencia

### Decisión provisional

- PostgreSQL 18.
- pgvector 0.8.7 como candidata inicial.

Antes de aprobar las imágenes se verificarán las etiquetas publicadas, la procedencia, las versiones incluidas y la compatibilidad entre PostgreSQL y pgvector.

También se probarán las migraciones, las consultas vectoriales y la persistencia de datos.

Referencias:

- https://www.postgresql.org/support/versioning/
- https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md

## 8. Gestión de trabajos asíncronos

Redis y BullMQ permanecen pendientes de una decisión específica.

Se comparará una cola con Redis frente a una solución respaldada por PostgreSQL, teniendo en cuenta:

- Persistencia del estado.
- Reintentos e idempotencia.
- Recuperación tras errores.
- Integración entre servicios TypeScript y Python.
- Complejidad de despliegue.
- Necesidad de procesamiento concurrente.

Solo se incorporarán si la evaluación justifica su coste operativo.

## 9. Reproducibilidad y cadena de suministro

El proyecto deberá:

- Mantener lockfiles versionados.
- Fijar versiones compatibles y actualizar dependencias de forma controlada.
- Evitar secretos en repositorios e imágenes.
- Utilizar imágenes base de procedencia evaluada.
- Registrar las versiones utilizadas en CI.
- Ejecutar pruebas y comprobaciones tras cambios relevantes.
- Revisar avisos de seguridad antes de una actualización importante.

Las etiquetas de imagen y las versiones de dependencias se verificarán antes de incorporarlas a la configuración definitiva.

## 10. Criterios para aprobar la línea base

Esta decisión se considerará validada cuando:

1. Las dependencias se resuelvan sin conflictos conocidos.
2. Los servicios arranquen con los runtimes fijados.
3. Los lockfiles permitan reproducir la instalación.
4. Las pruebas básicas del frontend, backend, motor de IA y MCP se ejecuten correctamente.
5. La configuración de CI use los mismos runtimes previstos.
6. Se documenten y corrijan las incompatibilidades encontradas.
7. Las versiones de los contenedores y las dependencias estén registradas.

## 11. Estado

Las versiones anteriores son decisiones de partida. La validación completa requiere ejecutar las instalaciones y pruebas; la documentación oficial, por sí sola, no demuestra que la integración completa funcione.
