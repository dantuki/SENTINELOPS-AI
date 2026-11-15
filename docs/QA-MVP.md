# SentinelOps AI Quality Assistant — MVP

## Estado y alcance

El MVP implementa un flujo de QA **solo lectura** para una persona ya
autenticada y autorizada en un proyecto existente:

1. Selecciona un workspace y un proyecto que la sesión puede consultar.
2. Introduce una URL canónica de repositorio público de GitHub.
3. La API obtiene un inventario de metadatos acotado por la API REST pública de GitHub y separa ese inventario del contenido descargado.
4. Un motor determinista revisa una muestra de archivos de texto seleccionada por categoría.
5. La interfaz muestra hallazgos con evidencia y permite preguntas locales sobre
   el informe de esa sesión.

Está implementado el análisis de scripts de `package.json`, inventario de rutas de tests,
material con cabeceras de claves privadas y uso de `eval(...)`. Los hallazgos
incluyen regla/versionado, archivo, rango de líneas, extracto redactado y
SHA-256 del contenido inspeccionado. No se calcula un “score de calidad”.

La selección descarga como máximo 30 archivos y conserva presupuestos deterministas: manifiestos principales (4), configuración de prueba/lint/CI (4), rutas de prueba (8), código representativo (10) y documentación técnica (4). Las rutas restantes se inventarían sólo como metadatos y se declaran como no descargadas; la interfaz nunca afirma que todo el repositorio fue revisado.

Las pruebas se comunican por separado: script declarado en un manifiesto inspeccionado, rutas detectadas en el inventario y ejecución (`not_executed`). No observar una ruta de pruebas en la muestra ni un script en un manifiesto omitido no permite concluir que el repositorio carece de pruebas.

El flujo no sustituye ni modifica `/investigation`, el Verified Fact Engine,
la procedencia de evidencia, el evaluador INC-001 ni Product Gate V2. Es un
producto paralelo que reutiliza exclusivamente el aislamiento ya existente de
workspace/proyecto y las fuentes `git_repository`.

## Límites de seguridad del importador

El importador acepta solo `https://github.com/<owner>/<repository>` (con el
sufijo `.git` opcional). No admite URLs de API, puertos, credenciales, query
strings, fragmentos ni rutas internas. Construye internamente las solicitudes
HTTPS a `api.github.com`; no sigue redirecciones ni utiliza `download_url` u
otras URLs entregadas por un tercero.

La consulta se limita a una rama por defecto y a inventario de blobs de texto:

| Límite | Valor actual |
| --- | ---: |
| Entradas del árbol | 2.000 |
| Archivos de texto | 30 |
| Archivo individual | 64 KiB |
| Contenido total | 768 KiB |
| Respuesta JSON | 2 MiB |
| Tiempo por solicitud GitHub | 12 s |

Se excluyen rutas de construcción, dependencias, `.git` y rutas no seguras.
El contenido se mantiene en memoria para el análisis; la base persiste sólo la
identidad del origen y metadatos del repositorio, no los cuerpos de archivos ni
extractos del informe. Un origen deshabilitado no se reactiva mediante esta
ruta.

Nunca se ejecutan `npm install`, scripts del repositorio, tests, binarios,
contenedores ni archivos descargados. El estado de prueba se presenta
explícitamente como `not_executed`.

## Contrato de producto y conversación

La ruta protegida es:

```text
POST /api/projects/:projectId/qa/github
{ "repositoryUrl": "https://github.com/owner/repository" }
```

Requiere sesión, origen/CSRF para la operación mutante y permiso
`project.manage`; una falta de autorización no dispara llamadas a GitHub. La
respuesta contiene `source`, una identidad de repositorio y un informe
estructurado. La web valida su forma antes de renderizarla.

Después de un informe válido, la conversación de QA se resuelve localmente
sobre ese informe de la sesión. Sólo puede explicar hallazgos, ubicaciones,
recomendaciones y la ausencia de ejecución. No invoca el endpoint genérico de
chat ni un modelo generativo; por tanto no produce una conclusión fuera de la
evidencia estática recibida.

## Ejecución local y validación

No cambie `.env` para usar el flujo. Con los servicios de autenticación y
producto configurados para el entorno local, ejecute la web y API como parte
del stack habitual y abra `/qa` tras iniciar sesión. El repositorio público se
importa sólo después de seleccionar un proyecto autorizado.

Las validaciones de código disponibles son:

```powershell
npm.cmd test --workspace=@sentinelops/api
npm.cmd test --workspace=@sentinelops/web
npm.cmd run typecheck --workspace=@sentinelops/api
npm.cmd run typecheck --workspace=@sentinelops/web
npm.cmd run build --workspace=@sentinelops/web
git diff --check
```

Las pruebas cubren URL canónica, límites y rutas no seguras, ausencia de
ejecución, evidencia/redacción, autorización, origen deshabilitado, contrato
web y respuestas deterministas sobre el informe. Una ejecución E2E contra una
instancia autenticada y GitHub público debe registrarse separadamente: las
pruebas unitarias no demuestran disponibilidad de GitHub ni despliegue.

## Capacidades fuera de alcance

- Importación de ZIP y repositorios privados.
- Ejecución aislada de tests, instalaciones, build o linters del repositorio.
- OAuth de GitHub, sincronización continua y almacenamiento de informes.
- Calificación comercial de calidad, cobertura de tests o auditoría completa de
  vulnerabilidades.
- Generación libre o diagnóstico causal de incidentes.

El siguiente incremento de ejecución debe utilizar una sandbox efímera,
política de red/recursos explícita, imagen allowlisted, timeout, logs
redactados y destrucción verificable. No debe reutilizar PostgreSQL, Docker ni
credenciales habituales sin una autorización específica.

## Evolución y monetización (propuesta; no implementada)

1. **Demo local:** repositorios públicos, reglas estáticas y datos efímeros.
2. **Piloto autenticado:** persistir informes mínimos, control de cuota por
   workspace y observabilidad de importaciones sin guardar secretos.
3. **Plan Pro:** OAuth de GitHub con permisos mínimos, análisis de repositorios
   privados mediante una integración auditada y sandbox de ejecución.
4. **Enterprise:** SSO, aislamiento por organización, retención configurable,
   auditoría exportable y runners gestionados por el cliente.

Antes de habilitar pagos, comparar el modelo de comisiones, países soportados,
reembolsos y requisitos fiscales directamente en la documentación vigente de
los proveedores de cobro candidatos. La selección o integración de un
proveedor no forma parte de este MVP.

### Despliegue incremental recomendado

La siguiente comparación fue revisada el **2026-11-14** y debe confirmarse de
nuevo antes de contratar o publicar:

| Etapa | Recomendación | Motivo y límite |
| --- | --- | --- |
| Demo privada | Web y API en instancias gratuitas de Render; base temporal separada | Render documenta servicios web y Postgres gratuitos para pruebas, pero los servicios se suspenden tras 15 minutos inactivos y no son para producción. |
| Base de demo | Neon Free sólo tras verificar `pgvector`, región y límites actuales | Neon anuncia una capa gratuita, pero sus recursos y condiciones cambian; no migrar datos habituales ni secretos de desarrollo. |
| Piloto comercial | Web Next.js en un plan comercial, API Fastify en un web service/contenedor gestionado y PostgreSQL administrado | Vercel Hobby está destinado a uso personal/no comercial; no debe alojar un producto comercial. Mantener API y base separadas permite límites de red y escalado independientes. |
| Producción | Servicio de API con health checks, backup/PITR, logs redactados, cuota por workspace y alertas de gasto | No se habilita hasta que existan OAuth, gestión de secretos, retención, auditoría y sandbox de ejecución. |

Referencias de verificación: [Vercel plans](https://vercel.com/docs/plans/hobby),
[Render free services](https://render.com/docs/free) y
[Neon pricing update](https://neon.com/blog/new-usage-based-pricing). Estos
enlaces documentan capacidades de proveedor, no una configuración ya
desplegada por SentinelOps.

### Cobros futuros en Colombia

Para validar interés sin procesar tarjetas, usar primero un enlace de pago
externo y registro manual de acceso. Mercado Pago documenta Links de pago y
suscripciones como alternativas sin integración compleja. Para una integración
posterior, usar Checkout alojado/Bricks, webhooks firmados e idempotencia de
eventos; los access tokens quedan exclusivamente en el servidor. Wompi es un
candidato local que debe compararse por medios de pago, tarifa vigente,
suscripciones, webhooks, reembolsos y soporte jurídico antes de elegirlo.

No se implementó cobro, checkout, webhook, plan de suscripción ni manejo de
credenciales. Referencias: [Mercado Pago: primeros pasos](https://www.mercadopago.com.co/developers/es/docs/getting-started),
[seguridad de credenciales](https://www.mercadopago.com.co/developers/es/reference)
y [Wompi: información de cuenta independiente](https://wompi.com/assets/downloadble/crear_cuenta_independiente.pdf).

## Arquitectura del flujo

```text
Browser autenticado
  -> proxy Next.js (validación de payload y sesión)
  -> Fastify (CSRF + RBAC + proyecto)
  -> GitHub REST público, lista acotada
  -> motor estático determinista
  -> informe con evidencia
  -> conversación determinista de la sesión
```

El contenido de GitHub es no confiable en cada etapa. No se usa como
instrucción ni se convierte en hechos del motor de incidentes.
