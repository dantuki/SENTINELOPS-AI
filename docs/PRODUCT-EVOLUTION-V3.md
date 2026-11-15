# Product Evolution V3

## Estado auditado — 2026-11-14

- **Implementado:** sesiones con cookies HttpOnly, protección CSRF, RBAC por
  workspace/proyecto, importación pública de GitHub limitada y QA estático
  determinista con evidencia de archivo/línea/hash.
- **Implementado en esta entrega, pendiente de migración aislada:** memoria de
  conversaciones de QA, mensajes, ejecuciones e identidades de hallazgos.
- **No implementado:** OAuth de Google/GitHub, ZIP, ejecución dinámica,
  proveedores LLM remotos, análisis externos, colas de trabajo y progreso SSE.

## Decisiones

1. `/qa` es la superficie principal, pero el análisis determinista mantiene su
   contrato independiente de investigación de incidentes y Product Gate V2.
2. La memoria se aísla por `project_id`; las rutas se protegen por `project.read`
   o `project.investigate` antes de que el repositorio consulte la base.
3. Las tablas de QA no guardan cuerpos de repositorios ni extractos de evidencia.
   Conservan la revisión, inventario resumido, hallazgos y referencia
   `path + lines + SHA-256`. Por ello un informe histórico puede señalar la
   evidencia, no reconstruir contenido que no se retuvo.
4. La importación actual es síncrona. La UI sólo muestra estados que el backend
   ya completó; los eventos de progreso reales requieren una cola/worker
   persistente o un importador instrumentado con SSE, que sigue pendiente.
5. Los ZIP y la ejecución de herramientas externas quedan `not_available` hasta
   contar con worker efímero, red denegada, límites de CPU/memoria/tiempo,
   filesystem temporal y limpieza verificable.
6. El login social queda `configuration_required`: faltan credenciales OAuth y
   no se crean callbacks ni flujos simulados.

## Esquema aditivo propuesto

`009_add_qa_conversation_memory.sql` crea conversaciones, mensajes, ejecuciones
de QA y hallazgos. Es transaccional, aditiva e idempotente en sus objetos. Debe
aplicarse **únicamente** a una PostgreSQL temporal aislada primero; no fue
ejecutada contra el contenedor, volumen o puerto habitual.

## Criterios de aceptación de Milestone 1

- Las conversaciones, mensajes y ejecuciones quedan asociadas a un proyecto.
- Los listados están ordenados por fijado y actividad, sin cruzar proyectos.
- Las consultas se encuentran detrás de la autorización de proyecto existente.
- Un informe conserva su `analysisId`, revisión e identidad de hallazgos.
- El navegador no recibe secretos ni cuerpos de repositorio persistidos.

## Próximos milestones

- **M2:** convertir la importación en trabajo persistido y emitir etapas reales
  con SSE o polling; las etapas nunca se temporizan en el cliente.
- **M3:** integrar una herramienta por lenguaje dentro de un worker aislado,
  empezando por TypeScript o Python, y registrar resultados por herramienta.
- **M4:** OAuth/OIDC sólo con credenciales válidas, state/PKCE/nonce y una
  política de asociación de identidades revisada.
