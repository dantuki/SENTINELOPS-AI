# Fundamentos de autenticación y autorización

Este documento describe los controles incorporados para la primera fase de seguridad. Su presencia en código no equivale a una certificación de producción; las limitaciones de verificación están al final.

## Configuración

El archivo raíz `.env.example` contiene los valores de desarrollo local. Cópialo a `.env` y sustituye los valores de PostgreSQL antes de iniciar servicios. No guardes `.env` en Git.

La API de producto requiere `NODE_ENV=development|production`, `APP_ORIGIN` y `SESSION_COOKIE_SECURE`. En desarrollo local, el origen debe coincidir exactamente con el navegador (por ejemplo, `http://127.0.0.1:3000`) y las cookies sin `Secure` solo se permiten en loopback. En producción, configura un origen HTTPS canónico y `SESSION_COOKIE_SECURE=true`.

El orquestador requiere `SENTINELOPS_ENV=development|production`. En desarrollo aislado de loopback, `AI_ORCHESTRATOR_API_KEY` puede omitirse; para autenticar llamadas entre la API y el orquestador, establece el mismo valor en ambos procesos. En producción es obligatorio y debe tener al menos 32 caracteres. Puede generarse con:

```powershell
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

No uses valores de ejemplo como claves reales. En producción, protege las variables mediante el gestor de secretos del entorno y mantén el orquestador en una red privada.

## Inicialización local

Después de configurar PostgreSQL y revisar una copia de seguridad cuando la base ya contenga datos, aplica las migraciones existentes:

```powershell
npm.cmd --prefix apps/api run migrate
```

Crea el administrador inicial desde una terminal interactiva. La contraseña se solicita sin eco y debe tener entre 12 y 1024 caracteres:

```powershell
npm.cmd --prefix apps/api run admin -- bootstrap-admin
```

La operación es de una sola instancia: un bloqueo transaccional impide crear administradores iniciales concurrentes y el comando falla si ya existe uno. Las cuentas adicionales se crean desde la API como administrador de instancia.

Para workspaces preexistentes, la adopción no es automática. Lista los que todavía no tienen propietario y adopta cada uno explícitamente:

```powershell
npm.cmd --prefix apps/api run admin -- list-unowned-workspaces
$workspaceId = "UUID_OBTENIDO_DEL_LISTADO"
npm.cmd --prefix apps/api run admin -- adopt-workspace $workspaceId
```

La adopción solicita las credenciales de un administrador de instancia y confirmación del UUID exacto. La recuperación de acceso también es interactiva, requiere confirmar el correo y revoca las sesiones actuales:

```powershell
npm.cmd --prefix apps/api run admin -- recover-admin-access
```

## Sesiones, cookies y protección de solicitudes

- Las contraseñas se almacenan con scrypt; los tokens de sesión y CSRF se almacenan como hashes.
- La sesión dura 12 horas y puede rotarse hasta el límite absoluto de 7 días desde la autenticación inicial.
- Las cookies son `HttpOnly` para la sesión y `SameSite=Strict`; en producción usan el prefijo `__Host-` y `Secure`.
- Las solicitudes que cambian estado requieren un `Origin` permitido y un token CSRF coincidente en cookie y cabecera.
- El login limita intentos por correo y dirección de origen mediante buckets con hash; los valores predeterminados son 10 por correo y 60 por IP en 15 minutos.
- Las rutas `/health` y `/ready` son públicas para comprobaciones operativas. Las rutas `/api/*` no incluidas en la política explícita se deniegan por defecto.

Fastify no confía actualmente en cabeceras de proxy. Detrás de un reverse proxy, `request.ip` puede ser la dirección del propio proxy y el límite por IP no distinguirá clientes. El comportamiento de rate limiting y la cadena de proxies deben validarse antes de un despliegue de ese tipo.

## Roles y alcance

| Rol | Alcance |
|---|---|
| `INSTANCE_ADMIN` | Administración de usuarios y workspaces. No obtiene acceso automático a los datos de proyectos. |
| `WORKSPACE_OWNER` | Administración del workspace y acceso a sus proyectos. |
| `WORKSPACE_MEMBER` | Acceso al workspace, pero solo a los proyectos con membresía explícita. |
| `PROJECT_ADMIN` | Administración de su proyecto y sus membresías, sin poder conceder el rol de administrador de proyecto. |
| `INVESTIGATOR` | Lectura e investigación del proyecto. |
| `VIEWER` | Lectura del proyecto. |

Las concesiones y revocaciones de membresía invalidan las sesiones del usuario afectado. El acceso a un recurso de proyecto o workspace no autorizado devuelve `404` para reducir la exposición de su existencia. El endpoint de chat solo requiere una membresía apta para investigación en algún proyecto; no es una interfaz para consultar documentos de un proyecto y no debe usarse para ese fin.

## Auditoría y límites de confianza

Los eventos de autenticación, cambios administrativos y denegaciones se registran sin contraseñas ni tokens. La dirección IP se guarda como hash. Las operaciones de bootstrap, adopción y recuperación requieren acceso local a la base y a una terminal; no existe un flujo remoto de recuperación.

La autorización del navegador no es la frontera de seguridad: la API valida cada ruta y el acceso a proyectos se comprueba en el backend. Las llamadas de inferencia del API al orquestador pueden usar autenticación de servicio; los endpoints `/health` y `/ready` siguen públicos. No expongas directamente el orquestador a redes no confiables.

## Verificación y límites

Las pruebas unitarias de seguridad cubren denegación por defecto, sesión requerida, validación de Origin/CSRF, ocultación de recursos y configuración de cookies. La autorización SQL y el aislamiento entre usuarios requieren pruebas de integración contra una base PostgreSQL aislada con la migración aplicada.

La incorporación de esta fase no valida por sí sola el despliegue, las copias de seguridad, la seguridad de infraestructura, la recuperación ante desastres ni la resistencia completa a ataques. No se debe declarar producción lista hasta completar esas verificaciones y revisar el modelo de amenazas.
