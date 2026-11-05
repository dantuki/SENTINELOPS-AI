# ADR-0005: Autenticación local, sesiones y autorización por proyecto

- **Estado:** Aceptado

## Contexto

La API de producto sirve información de incidentes y documentos con alcance por workspace y proyecto. La autenticación previa no permitía identificar usuarios ni imponer permisos de manera uniforme en cada endpoint.

## Decisión

- Mantener autenticación local con contraseñas derivadas mediante scrypt y sesiones opacas con tokens aleatorios.
- Persistir usuarios, sesiones, membresías, límites de login y auditoría en PostgreSQL mediante una migración aditiva.
- Aplicar autorización en la API con una lista explícita de políticas y denegar por defecto las rutas `/api/*` no mapeadas.
- Modelar roles separados para instancia, workspace y proyecto. Un administrador de instancia no hereda acceso a datos de proyectos.
- Requerir Origin y CSRF en solicitudes que cambian estado; la interfaz web solo reenvía las credenciales y no decide permisos.
- Autenticar las llamadas API-orquestador mediante una clave compartida configurable, obligatoria en producción.
- Mantener bootstrap, adopción de workspaces existentes y recuperación de administrador como comandos locales explícitos.

## Consecuencias

- La base debe aplicar la migración de seguridad antes de habilitar endpoints autenticados.
- Los workspaces existentes requieren adopción interactiva para obtener un propietario; no se asignan permisos automáticamente.
- Las sesiones afectadas se revocan al modificar estado de cuenta o membresías.
- La política debe actualizarse cuando se añada una ruta API nueva y debe tener pruebas que demuestren los permisos esperados.
- La autorización del proyecto requiere pruebas de integración con PostgreSQL; las pruebas unitarias de hooks no sustituyen esa verificación.

## Alternativas descartadas

- Confiar en la ocultación de páginas o controles del frontend.
- Conceder acceso global a proyectos a los administradores de instancia.
- Asignar automáticamente propietarios a workspaces existentes.
- Usar sesiones almacenadas en el navegador o contraseñas en texto claro.
- Permitir rutas API nuevas sin una política explícita.
