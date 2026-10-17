
# ADR-0003: Herramientas MCP restringidas y de solo lectura

- **Estado:** Aceptado
- **Fecha:** 2026-10-17

## Contexto

SentinelOps AI utilizará herramientas MCP para consultar documentación, código fuente, contratos API y registros de incidentes.

El modelo puede equivocarse, generar argumentos inesperados o interpretar contenido malicioso como instrucciones. Por tanto, no puede ser la autoridad que determine qué recursos está autorizado a consultar.

## Decisión

La primera versión utilizará herramientas de investigación de solo lectura.

El servidor MCP impondrá los permisos y las restricciones mediante código, independientemente de lo que solicite el modelo.

Las herramientas previstas incluyen:

- `search_knowledge_base`
- `search_repository`
- `get_source_excerpt`
- `search_incident_logs`
- `get_api_contract`
- `list_project_sources`
- `get_incident_context`

Los nombres definitivos podrán ajustarse durante la implementación, manteniendo las responsabilidades y los controles definidos.

## Controles obligatorios

1. Validación estricta de argumentos.
2. Lista permitida de herramientas.
3. Autorización por usuario, workspace y proyecto.
4. Límites de longitud y cantidad de resultados.
5. Timeouts y límites de concurrencia.
6. Restricción de rutas y prevención de path traversal.
7. Errores que no filtren secretos.
8. Auditoría de las invocaciones.
9. Pruebas de aislamiento entre proyectos.
10. Rechazo de operaciones de escritura no autorizadas.

Los documentos y registros recuperados se tratarán como datos no confiables. Una instrucción encontrada en una fuente no podrá conceder permisos ni modificar las políticas del sistema.

## Operaciones futuras

Cualquier función futura capaz de cambiar un entorno o modificar datos sensibles deberá contar con un flujo de aprobación explícito.

La aprobación tendrá un alcance concreto y no concederá autorización permanente para otras operaciones.

## Alternativas descartadas

### Acceso general a la shell

No se proporcionará al modelo una consola irrestricta ni la capacidad de ejecutar comandos arbitrarios.

### Acceso directo y amplio a la base de datos

No se proporcionarán al modelo credenciales generales de base de datos. Las consultas se ejecutarán a través de interfaces controladas y autorizadas.

### Confiar únicamente en instrucciones del prompt

Las instrucciones al modelo no sustituyen controles de acceso, validación, aislamiento y restricciones impuestas por código.

## Consecuencias

- Las herramientas serán implementadas como un servidor MCP real.
- Los permisos no dependerán de que el modelo obedezca instrucciones.
- Los intentos de acceso cruzado y las entradas maliciosas tendrán pruebas específicas.
- La seguridad se evaluará según controles y resultados observables; no se considerará garantizada por la mera existencia de guardrails.

## Criterio de validación

La decisión se considerará implementada cuando las herramientas puedan invocarse mediante el protocolo MCP y existan pruebas que demuestren los permisos, los límites de ejecución y el rechazo de operaciones fuera del alcance.
