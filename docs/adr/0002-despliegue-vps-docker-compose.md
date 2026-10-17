
# ADR-0002: Despliegue en VPS Linux mediante Docker Compose

- **Estado:** Aceptado como dirección de despliegue
- **Fecha:** 2026-10-17

## Contexto

SentinelOps AI debe poder ejecutarse en un entorno local de desarrollo y desplegarse posteriormente en un VPS Linux administrado por nosotros.

La solución debe evitar exponer directamente los servicios internos y debe contar con procedimientos reproducibles de instalación, actualización, recuperación y mantenimiento.

## Decisión

Utilizar Docker Compose como estrategia inicial para coordinar los contenedores de la aplicación y sus dependencias.

El despliegue público utilizará un proxy inverso con HTTPS. Caddy, Nginx y Traefik se evaluarán antes de seleccionar el componente definitivo.

## Topología prevista

- Internet: acceso web público.
- Firewall del proveedor y del sistema operativo.
- Proxy inverso: entrada HTTP y HTTPS.
- Frontend: aplicación web.
- API de producto: operaciones autenticadas.
- Motor de IA: servicio interno.
- Servidor MCP: servicio interno.
- PostgreSQL y pgvector: persistencia privada.
- Redis y trabajadores: únicamente si se justifica su incorporación.
- Ollama: acceso local o privado, nunca expuesto públicamente por defecto.

## Seguridad de despliegue

- Publicar únicamente los puertos necesarios.
- Mantener las bases de datos y los servicios internos en redes privadas.
- Usar variables de entorno y mecanismos de gestión de secretos adecuados.
- Ejecutar los contenedores con privilegios mínimos cuando sea viable.
- No montar el socket Docker en los contenedores de aplicación.
- Definir health checks, límites de recursos y rotación de logs.
- Mantener separados los entornos de desarrollo, pruebas y producción.
- Preparar backups, restauración, actualización y rollback.
- Probar los controles de acceso y la exposición efectiva de los puertos.

## Alternativas consideradas

### Kubernetes

Ofrece mayores capacidades de orquestación, pero incorpora complejidad operativa que no está justificada para la primera versión.

### Plataforma PaaS

Puede simplificar operaciones, pero no es la estrategia principal solicitada para este proyecto.

### Docker Compose en un VPS

Proporciona una configuración reproducible con un modelo operativo proporcionado al alcance inicial.

## Consecuencias

- La infraestructura se documentará y versionará.
- La configuración de producción será independiente de la configuración de desarrollo.
- No se afirmará que el despliegue está listo o es seguro hasta ejecutar las comprobaciones pertinentes.
- La región, capacidad y proveedor del VPS se decidirán posteriormente con información de costos y recursos.

## Criterios de validación

Antes de considerar listo el despliegue deberán verificarse los puertos expuestos, HTTPS, los permisos, la separación entre servicios, los backups y una restauración real.
