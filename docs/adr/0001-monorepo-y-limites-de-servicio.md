
# ADR-0001: Monorepo y límites de los servicios

- **Estado:** Propuesto
- **Fecha:** 2026-10-17
- **Decisión:** organizar inicialmente el proyecto como un monorepo.

## Contexto

SentinelOps AI requiere varios componentes que deben evolucionar coordinadamente:

- Una aplicación web con Next.js y TypeScript.
- Una API de producto con Fastify y TypeScript.
- Un motor de IA con Python y FastAPI.
- Un servidor MCP independiente implementado con TypeScript.
- Contratos compartidos, infraestructura, migraciones, pruebas y documentación.

Separar todos estos componentes en repositorios diferentes desde el principio aumentaría la coordinación y dificultaría los cambios que afectan a varios servicios.

## Decisión propuesta

Mantener los componentes dentro de un único repositorio Git, respetando sus límites de responsabilidad y ejecución.

La estructura inicial propuesta es:

- `apps/web`: interfaz de usuario.
- `apps/api`: API de producto.
- `services/ai-orchestrator`: motor y workflow de IA.
- `services/mcp-server`: servidor MCP.
- `packages/shared-contracts`: contratos compartidos.
- `packages/config`: configuración común cuando esté justificada.
- `infra`: despliegue y migraciones.
- `datasets`: datos sintéticos de demostración y evaluación.
- `docs`: arquitectura, decisiones y manuales.
- `tests`: pruebas de integración y extremo a extremo.

Los servicios mantendrán sus propias dependencias, comandos de ejecución y pruebas.

## Alternativas consideradas

### Repositorios separados

Cada servicio tendría su propio repositorio.

Ventajas:
- Separación de permisos e historiales.
- Versionado independiente.

Desventajas:
- Mayor coordinación inicial.
- Más complejidad al modificar contratos compartidos.
- Más trabajo de configuración y CI para este alcance.

### Monorepo

Todos los componentes comparten el repositorio, pero mantienen límites explícitos.

Ventajas:
- Cambios coordinados.
- Documentación centralizada.
- Configuración y pruebas integradas.

Desventajas:
- Es necesario controlar cuidadosamente las dependencias y los límites entre componentes.
- El pipeline de CI deberá evitar trabajo innecesario cuando cambien archivos de un solo servicio.

## Consecuencias

- La versión inicial se desarrollará en un solo repositorio.
- Las dependencias de Python y Node.js se gestionarán separadamente.
- Los contratos entre servicios se definirán explícitamente.
- No se permitirá que los componentes compartan lógica de negocio de forma descontrolada.
- Se revisará esta decisión si el proyecto adquiere necesidades reales de versionado, permisos o despliegue independiente.

## Validación pendiente

La estructura se aprobará definitivamente cuando se confirme que el monorepo puede ejecutarse y probarse de forma reproducible.
