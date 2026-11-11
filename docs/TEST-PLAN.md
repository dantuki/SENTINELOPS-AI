
# SentinelOps AI — Plan de pruebas

## 1. Propósito

Este documento define la estrategia de pruebas para SentinelOps AI.

El objetivo es verificar la funcionalidad, integración, seguridad y calidad de los resultados del sistema mediante comprobaciones reproducibles.

Las pruebas deberán demostrar comportamientos concretos. No se considerará suficiente que una pantalla parezca funcionar o que un modelo produzca una respuesta convincente.

**Estado:** plan vigente; ver el registro de ejecución al final para resultados reales y pendientes.

## 2. Principios

1. Cada prueba tendrá un objetivo y un resultado esperado.
2. Los errores deberán producir resultados visibles y verificables.
3. Los mocks estarán identificados y no sustituirán todas las pruebas de integración.
4. Los resultados de pruebas se registrarán con el comando utilizado y su salida relevante.
5. Las pruebas que no se ejecuten permanecerán pendientes.
6. Los datos sintéticos se identificarán claramente como datos de demostración.
7. Las pruebas de seguridad verificarán controles concretos sin pretender garantizar seguridad absoluta.
8. Los tests serán reproducibles siempre que las dependencias y el entorno lo permitan.
9. Las pruebas que necesiten servicios externos se separarán de la suite local ordinaria.
10. Los fallos no se ocultarán para permitir avanzar de fase.

## 3. Niveles de prueba

### 3.1. Pruebas unitarias

Se utilizarán para comprobar componentes aislados y lógica determinista.

Áreas previstas:

- Validación de esquemas.
- Reglas de clasificación y severidad.
- Normalización de documentos.
- Fragmentación de texto y código.
- Validación de referencias.
- Cálculo de métricas.
- Políticas de autorización.
- Redacción de secretos.
- Condiciones de parada del workflow.
- Validación de estructuras de salida.

Las pruebas unitarias no demostrarán por sí solas que los componentes integrados funcionen.

### 3.2. Pruebas de integración

Comprobarán la comunicación real entre componentes.

Áreas previstas:

- API y PostgreSQL.
- Persistencia de documentos y fragmentos.
- Generación y almacenamiento de embeddings.
- Recuperación vectorial y léxica.
- Cliente MCP y servidor MCP.
- API de producto y motor de IA.
- Gestión de errores y timeouts.
- Migraciones de base de datos.
- Autorización entre servicios.
- Procesamiento asíncrono, si se incorpora.

Se utilizarán servicios reales cuando el objetivo sea validar su integración. Los mocks se reservarán para aislar dependencias concretas.

### 3.3. Pruebas de extremo a extremo

Verificarán recorridos de usuario completos.

Recorrido principal previsto:

1. Crear o seleccionar un proyecto.
2. Incorporar una fuente autorizada.
3. Comprobar su ingestión e indexación.
4. Registrar un incidente.
5. Iniciar una investigación.
6. Consultar su estado.
7. Revisar hipótesis y referencias.
8. Consultar la traza.
9. Visualizar el resultado o la abstención.
10. Comprobar que el usuario solo accede a los recursos autorizados.

No se considerará probado un recorrido hasta ejecutarlo con los servicios necesarios y comprobar su resultado.

## 4. Pruebas del pipeline RAG

Se validarán los siguientes casos:

| Caso | Resultado esperado |
|---|---|
| Archivo Markdown válido | El texto se extrae y procesa correctamente |
| Archivo de texto vacío | Se informa que no contiene contenido utilizable |
| PDF válido | Se extrae el texto y se preserva la información de origen disponible |
| PDF corrupto | Se informa el error sin dar por exitosa la ingestión |
| Archivo demasiado grande | Se rechaza según los límites configurados |
| Tipo de archivo no permitido | Se rechaza antes del procesamiento |
| Archivo con código | Se preservan rutas y ubicaciones cuando estén disponibles |
| Documento modificado | Se detecta el cambio según la estrategia de indexación |
| Fuente no modificada | Se evita trabajo innecesario cuando sea posible |
| Consulta pertinente | Se recuperan documentos relevantes del proyecto autorizado |
| Consulta sin respaldo | Se obtiene un resultado vacío o insuficiente, sin inventar evidencia |
| Documentos de otros proyectos | No se devuelven a usuarios sin autorización |
| Repetición del mismo contenido | Se reutiliza el documento y no se generan embeddings duplicados |
| Documento aún en procesamiento | Se informa que el trabajo sigue pendiente, sin afirmar que está indexado |
| Documento archivado | Se rechaza la reingesta y no se afirma que se reindexó |
| Fuente deshabilitada | La ingesta y los reintentos no la reactivan |
| Timeout del proveedor de embeddings | Se conserva un estado reintentable y se informa el timeout |
| Fuente inactiva o documento sin indexar | Sus fragmentos no aparecen en los resultados |
| Búsqueda de incidente con documentos generales | Puede incluir evidencia del proyecto que no esté ligada a otro incidente |

Se comprobará también que las referencias identifican documentos y ubicaciones reales.

## 5. Pruebas de citas y fundamentación

Se probarán al menos estos casos:

- Referencia válida a una fuente almacenada.
- Identificador de documento inexistente.
- Ubicación incorrecta dentro de una fuente.
- Referencia perteneciente a otro proyecto.
- Afirmación sin respaldo documental suficiente.
- Documentos que aportan evidencias contradictorias.
- Fuentes recuperadas que no respaldan la afirmación asociada.
- Información insuficiente para identificar una causa raíz.

El sistema deberá rechazar referencias inválidas, distinguir las hipótesis de los hechos y abstenerse cuando resulte necesario.

Una cita existente no será suficiente por sí sola: se deberá verificar que su contenido respalda realmente la afirmación presentada.

## 6. Pruebas del servidor MCP

Se comprobarán:

- Inicialización del servidor.
- Negociación y comunicación mediante MCP.
- Descubrimiento de herramientas disponibles.
- Invocación de cada herramienta implementada.
- Validación de parámetros.
- Respuestas estructuradas.
- Accesos a proyectos autorizados.
- Denegación de accesos a proyectos ajenos.
- Nombres de archivos y rutas no permitidos.
- Límites de longitud y cantidad de resultados.
- Timeouts y errores de las fuentes.
- Auditoría de invocaciones.
- Ausencia de filtración de secretos en errores.
- Rechazo de herramientas no autorizadas.

Se utilizará un cliente MCP real para las pruebas de protocolo. Una llamada directa a una función no contará como prueba de integración MCP.

## 7. Pruebas del workflow de investigación

Se evaluarán los siguientes escenarios:

- Incidente con suficiente evidencia.
- Incidente con información incompleta.
- Evidencias contradictorias.
- Fallo de un proveedor de modelos.
- Fallo de una herramienta MCP.
- Timeout durante una etapa.
- Error de validación de una salida.
- JSON malformado y estructura de investigación inválida.
- Referencias fuera de la evidencia recuperada.
- Hipótesis con estados fuera del contrato.
- Violaciones deterministas de factualidad.
- Número máximo de iteraciones alcanzado.
- Cancelación de una investigación.
- Reintento permitido.
- Imposibilidad de verificar una hipótesis.
- Solicitud de una operación fuera del alcance autorizado.

Las investigaciones deberán terminar en un estado definido. No se permitirán iteraciones sin límite ni la conversión automática de una hipótesis en una causa raíz confirmada.

## 8. Pruebas de seguridad

### 8.1. Autenticación y autorización

- Solicitudes sin sesión válida.
- Roles sin permisos suficientes.
- Cambio de identificadores en solicitudes.
- Acceso cruzado entre workspaces.
- Acceso cruzado entre proyectos.
- Acceso a fuentes e incidentes de otros usuarios.
- Revocación de permisos cuando corresponda.

### 8.2. Entradas y archivos

- Solicitudes malformadas.
- Archivos sobredimensionados.
- Archivos corruptos.
- Extensiones engañosas.
- Nombres de rutas maliciosos.
- Intentos de path traversal.
- Exceso de solicitudes.
- Agotamiento de recursos por entradas grandes.

### 8.3. Prompt injection

Se incorporarán documentos sintéticos que contengan instrucciones maliciosas, intentos de ignorar las políticas del sistema y solicitudes para revelar información de otros proyectos.

Resultado esperado:

- El contenido documental se trata como información no confiable.
- Los documentos no pueden ampliar los permisos de una herramienta.
- Las políticas de ejecución se mantienen aunque una fuente contenga instrucciones contrarias.
- Las consultas continúan respetando los filtros de autorización.
- Los intentos detectados se registran sin exponer información sensible.

La detección de patrones sospechosos será una defensa adicional; no será el único mecanismo de protección.

### 8.4. Secretos y errores

- Comprobar que los errores no incluyan credenciales.
- Comprobar que el frontend no reciba claves privadas de proveedores.
- Verificar que los logs eviten almacenar secretos innecesarios.
- Verificar que los archivos de entorno reales no estén versionados.
- Comprobar la redacción de datos sensibles en los casos definidos.

## 9. Evaluación de recuperación y respuestas de IA

Se creará un dataset de evaluación con consultas, documentos relevantes esperados, resultados de referencia y casos de abstención.

Métricas previstas:

- Recall@k.
- Mean Reciprocal Rank (MRR).
- Relevancia de los documentos recuperados.
- Exactitud de las referencias.
- Fundamentación de las afirmaciones.
- Exactitud frente a una respuesta de referencia.
- Uso correcto de herramientas.
- Calidad del diagnóstico.
- Tasa de abstención apropiada.
- Resistencia ante ataques incluidos en el benchmark.
- Latencia y errores.
- Tokens y costos cuando existan datos reales disponibles.

Las métricas deterministas se separarán de las evaluaciones realizadas por un LLM.

Los evaluadores basados en modelos no serán el único criterio de aceptación de una respuesta. Se utilizarán verificaciones deterministas y ejemplos con resultados esperados cuando resulte posible.

Los resultados se guardarán junto con la versión del dataset y la configuración de la evaluación.

## 10. Pruebas de frontend

Se comprobarán:

- Formularios y sus validaciones.
- Manejo de sesiones y permisos.
- Estados de carga.
- Estados vacíos.
- Mensajes de error.
- Resultados parciales.
- Navegación desde las citas hacia sus fuentes.
- Visualización de hipótesis y hechos.
- Estado de indexación.
- Estado de las investigaciones.
- Acceso a trazas.
- Visualización de las métricas.
- Diseño responsive y controles accesibles.

Las acciones visibles deberán ejecutar operaciones reales o indicar explícitamente que una funcionalidad todavía no está disponible.

## 11. Pruebas de infraestructura

Se validarán:

- Construcción de imágenes.
- Arranque mediante Docker Compose.
- Health checks.
- Conectividad entre servicios autorizados.
- Persistencia después de reiniciar servicios.
- Aplicación de migraciones.
- Configuración necesaria para desarrollo.
- Separación de los entornos.
- Ausencia de puertos internos publicados innecesariamente.
- Restauración de una copia de seguridad.
- Procedimiento de actualización y rollback.

Las pruebas destructivas solo se ejecutarán en entornos de prueba aislados y con los datos controlados.

## 12. Automatización

La integración continua se incorporará progresivamente.

Comprobaciones previstas:

- Lint.
- Comprobaciones de tipos.
- Pruebas unitarias.
- Validaciones de formato y esquemas.
- Pruebas de integración seleccionadas.
- Auditoría de dependencias.
- Detección de secretos.
- Construcción de servicios.
- Pruebas de extremo a extremo en los entornos previstos.

Las pruebas que dependan de proveedores externos se ejecutarán en un flujo separado cuando sea necesario.

Los comandos exactos se documentarán una vez que estén definidos los scripts y las dependencias reales del monorepo.

## 13. Criterios generales de aceptación

Un hito se considerará aprobado cuando:

1. Los criterios acordados para el hito estén satisfechos.
2. Las comprobaciones pertinentes se hayan ejecutado.
3. Los resultados relevantes estén documentados.
4. Los fallos conocidos estén corregidos o registrados con una justificación explícita.
5. No haya errores críticos ocultos.
6. La documentación corresponda con el comportamiento comprobado.

No se establecerán umbrales numéricos de calidad de IA sin justificar el valor, el dataset y el método de medición.

## 14. Registro de resultados

Por cada ejecución relevante se registrará:

- Identificador o fecha de ejecución.
- Commit o versión evaluada.
- Entorno utilizado.
- Comando ejecutado.
- Pruebas realizadas.
- Resultado observado.
- Fallos encontrados.
- Limitaciones conocidas.
- Evidencias disponibles.

Estados permitidos:

- Pendiente.
- En ejecución.
- Aprobada.
- Fallida.
- Bloqueada.
- No aplicable, con justificación.

## 15. Estado actual

- Plan de pruebas documentado: sí.
- Pruebas Product API ejecutadas: 130 aprobadas en la validación correctiva del 8 de noviembre de 2026.
- Pruebas del AI Orchestrator ejecutadas: 34 aprobadas en la validación correctiva del 8 de noviembre de 2026.
- Typecheck de Product API: aprobado.
- Typecheck de la interfaz web: aprobado.
- Typecheck del runner y archivos de integración PostgreSQL: aprobado.
- Migraciones PostgreSQL 001–006: esquema e índices verificados en la ejecución local del 3 de noviembre de 2026; una ejecución posterior del runner aislado verificó 001–007 e idempotencia.
- Integración MCP verificada: no.
- Pipeline RAG con PostgreSQL real: parcialmente verificado; puerta E2E pendiente.
- Runner PostgreSQL aislado y pruebas de aislamiento y seguridad: aprobados en una ejecución anterior (2 pruebas aprobadas, 0 fallidas). Después se modificó su ciclo de vida; el runner real queda pendiente de repetición. La evaluación RAG de INC-001 y el Reliability Gate completo siguen pendientes.
- Casos deterministas de factualidad INC-001: implementados y aprobados.
- Runner reproducible para factualidad de INC-001: ejecutado en modo `--skip-ingestion`; la ejecución real no alcanzó la aceptación.

### Registro de ejecución — 3 de noviembre de 2026

Las siguientes pruebas se ejecutaron localmente contra el repositorio y no deben interpretarse como resultados de producción:

| Comprobación | Resultado |
|---|---|
| `npm.cmd test` (desde `apps/api`) | 78 aprobadas |
| `npm.cmd run typecheck` (desde `apps/api`) | Aprobado |
| `.\.venv\Scripts\python.exe -m pytest tests/test_app.py -q` (desde `services/ai-orchestrator`) | 26 aprobadas |
| `npm.cmd --prefix apps/api run migrate` | Registró las firmas legadas 001–004 y aplicó 005–006; una repetición indicó que todo estaba actualizado |
| PostgreSQL / pgvector | PostgreSQL 18.6 y pgvector 0.8.7 disponibles |
| Persistencia durante migraciones | Conteos previos y posteriores iguales: 1 workspace, 1 proyecto, 1 incidente, 2 fuentes, 3 documentos, 3 chunks y 3 embeddings |
| Importación real de INC-001 | Dos documentos indexados; reintento serial deduplicado con cero chunks y embeddings nuevos |
| Búsqueda semántica real | Recuperó logs y código sintético del proyecto; los resultados conservaron sus IDs y scores |
| Ground truth | No aparece en la lista allowlisted ni entre los documentos ingeridos |
| Readiness del AI Orchestrator | `/health` comprueba liveness; `/ready` confirmó que ambos modelos estaban cargados |
| Aislamiento entre proyectos | Prueba de integración aprobada en una base PostgreSQL aislada con datos sintéticos; no se sembró la base original |
| Evaluación factual de solo lectura (`--skip-ingestion`) | Recall de recuperación 1.0; cobertura de respuesta 1/6; una afirmación causal no demostrada; resultado fallido |
| Integridad de la base original durante la evaluación | Conteos antes y después iguales: 1 workspace, 1 proyecto, 2 incidentes, 3 fuentes, 5 documentos, 5 fragmentos y 5 embeddings |
| Investigación y recursos locales | Última investigación: 11.5 s; GPU hasta 100 %, VRAM hasta 5.6/6 GiB, RAM disponible mínima 6.1 GiB |
| Respuesta truncada por límite de tokens | AI Orchestrator la rechaza explícitamente; pruebas unitarias aprobadas |

La última evaluación real recuperó todos los hechos esperados y citó evidencia válida, pero la respuesta incluyó solo 1/6 observaciones medibles y afirmó que la saturación del pool causó el fallo. La evaluación determinista detectó esa afirmación no respaldada, por lo que la ejecución falló. El tiempo de investigación fue 11.5 segundos y se utilizó `--skip-ingestion`; los conteos de la base original no cambiaron. Las respuestas truncadas por el límite de tokens ahora se rechazan explícitamente en vez de devolverse como completas.

### Registro de implementación — Reliability Gate

En esta sesión se verificaron las siguientes pruebas locales:

| Comprobación | Resultado |
|---|---|
| `npm.cmd --prefix apps\api test` | 88 aprobadas |
| `npm.cmd --prefix apps\api run typecheck` | Aprobado |
| `npm.cmd --prefix apps\web run typecheck` | Aprobado |
| `services\ai-orchestrator\.venv\Scripts\python.exe -m pytest services\ai-orchestrator\tests -q` | 30 aprobadas |
| TypeScript del runner y pruebas PostgreSQL (compilador local con `--noEmit`) | Aprobado |
| `npm.cmd run typecheck --workspace=@sentinelops/api` (desde la raíz) | Aprobado (exit 0) |
| `npm.cmd run test:postgres --workspace=@sentinelops/api` (desde la raíz) | Aprobado (exit 0): migraciones 001–007 aplicadas, segunda ejecución idempotente (`Database migrations are up to date.`), 2 pruebas aprobadas y 0 fallidas |
| Suites del runner PostgreSQL | `project-isolation.integration.test.ts` y `security.integration.test.ts` ejecutadas secuencialmente (`--test-concurrency=1`) y aprobadas |
| Aislamiento del entorno de prueba | Contenedor temporal eliminado al terminar; `sentinelops-ai-postgres-1` siguió saludable y el volumen `sentinelops-ai_postgres_data` permaneció intacto |
| Evaluación real de INC-001 | No ejecutada; no se declara aprobado el gate |

En la ejecución anterior, `apps/api/scripts/run-postgres-integration.ts` usó un contenedor PostgreSQL temporal con base de datos exclusiva y puerto dinámico, verificó las migraciones 001–007 e idempotencia y ejecutó secuencialmente las suites de aislamiento y seguridad; reportó 2 pruebas aprobadas y 0 fallidas. La base PostgreSQL habitual y su volumen permanecieron intactos. El runner se endureció después para reconciliar una creación parcial, proteger la contraseña y verificar la eliminación del contenedor y su volumen; esos cambios solo cuentan con pruebas unitarias y typecheck, y el runner real no se ha vuelto a ejecutar. La aserción de workspaces compara la respuesta con los IDs existentes en `workspaces`, en lugar de depender de una cantidad fija. Siguen pendientes la repetición del runner tras el hardening, la evaluación real de INC-001 y el cierre del Reliability Gate.

La primera inferencia medida para la generación corta tardó aproximadamente 18 segundos; la primera llamada de embeddings medida tardó aproximadamente 8 segundos. En las capturas locales, la GPU reportó entre 5.6 y 5.7 GiB usados de 6 GiB y hasta 98 % de utilización. Son mediciones puntuales bajo carga concurrente, no un benchmark sostenido.

**PHASE 3.1: BLOCKED.** El aislamiento se aprobó con fixtures en una base aislada, pero la respuesta real de INC-001 no alcanzó la cobertura factual requerida y afirmó causalidad no demostrada. Phase 4 permanece pendiente.

El runner reproducible se invoca como `npm.cmd --prefix apps/api run evaluate:inc001 -- <PROJECT_UUID>`. La ejecución completa no se marcó como aprobada en esta sesión porque las investigaciones reales tuvieron timeouts variables.

### Validación de diagnósticos y cleanup — 8 de noviembre de 2026

| Comprobación | Resultado |
|---|---|
| `npm.cmd run typecheck --workspace=@sentinelops/api` | Aprobado (exit 0) |
| `npm.cmd test --workspace=@sentinelops/api` | 115 aprobadas, 0 fallidas |
| TypeScript del runner aislado y sus pruebas (`tsc --ignoreConfig --noEmit`, desde `apps\api`) | Aprobado |
| `services\ai-orchestrator\.venv\Scripts\python.exe -m pytest services\ai-orchestrator\tests\test_app.py -q` | 33 aprobadas |

La API ahora registra para respuestas estructuradas inválidas solo códigos y rutas de campos acotadas y sanitizadas; no incluye el texto generado en esos diagnósticos y mantiene un error genérico hacia el cliente. El orquestador admite el esquema JSON de investigación y lo entrega a Ollama. El evaluador etiqueta fallos con una etapa conocida y el runner la incorpora a `meta.json`; la limpieza solo se declara verificada cuando se confirman la detención de procesos y la eliminación o ausencia de los recursos temporales. Estas comprobaciones fueron unitarias y de tipo: no se ejecutó INC-001 ni el runner PostgreSQL en esta validación.

### Validación de correcciones de confiabilidad

| Comprobación | Resultado |
|---|---|
| `npm.cmd test --workspace=@sentinelops/api` | 126 aprobadas, 0 fallidas |
| `npm.cmd run typecheck --workspace=@sentinelops/api` | Aprobado |
| `npm.cmd run typecheck --workspace=@sentinelops/web` | Aprobado |
| `services\ai-orchestrator\.venv\Scripts\python.exe -m pytest tests -q` | 34 aprobadas |
| TypeScript de runners, helpers y pruebas unitarias (`tsc --ignoreConfig --noEmit`) | Aprobado |
| Paridad del JSON Schema de investigación | Prueba de API aprobada y prueba de Orchestrator aprobada |
| `test:postgres`, runner aislado de INC-001, Docker, PostgreSQL, migraciones y evaluación RAG | No ejecutados en esta validación |

La cobertura ejecutada es unitaria, de contratos y de tipos. No verifica el nuevo ciclo de vida contra Docker/PostgreSQL ni la calidad real de una respuesta de Ollama; esas comprobaciones siguen pendientes.

### Validación correctiva F-01, F-03 y F-06 — 8 de noviembre de 2026

| Comprobación | Resultado |
|---|---|
| `npm.cmd test --workspace=@sentinelops/api` | 130 aprobadas, 0 fallidas |
| `services\ai-orchestrator\.venv\Scripts\python.exe -m pytest tests -q` | 34 aprobadas |
| `npm.cmd run typecheck --workspace=@sentinelops/api` | Aprobado |
| `npm.cmd run typecheck --workspace=@sentinelops/web` | Aprobado |
| TypeScript de runners, helpers y pruebas (`tsc --ignoreConfig --noEmit`) | Aprobado |
| Coherencia independiente del reporte INC-001 | Pruebas rechazan métricas fabricadas, respuesta sin cobertura, evidencia no relacionada y filtración de referencia |
| Interrupciones y cleanup | Pruebas simuladas verifican primera señal, puntos de cancelación, `taskkill` concurrente y reporting de contenedor/volumen persistentes |
| Docker, PostgreSQL, migraciones y `test:postgres` | No ejecutados en esta validación |
| Runner aislado de INC-001 y evaluación RAG completa | No ejecutados |

El reporte INC-001 incluye las evidencias recuperadas junto con la respuesta; el runner vuelve a calcular desde esos datos las observaciones, citas, factualidad, abstención y filtración de referencia, y exige que coincidan con las métricas reportadas. Esto cierra la ruta de falsa aprobación reproducida con una respuesta genérica, pero la evaluación sigue siendo determinista y no demuestra por sí sola la calidad semántica general ni la procedencia real del contenido de una respuesta del modelo.

Los tests de interrupción, Windows y Docker usan emisores/adaptadores simulados. No demuestran la terminación de árboles de procesos en Windows real, el comportamiento de Docker Desktop, la eliminación efectiva de un contenedor/volumen ni el resultado de PostgreSQL integrado. El contenedor histórico `sentinelops-inc001-eval-025ea47223dd3ae9`, el volumen histórico identificado en la auditoría y la base PostgreSQL habitual no se inspeccionaron ni modificaron; esta validación no ejecutó comandos Docker ni SQL.
# Plan de pruebas de la traza de recuperación

La cobertura unitaria/de adaptadores incluye inserción atómica de trazas y rollback, discrepancias en la cabecera de una misma ejecución, discrepancias de lineage documento/fuente, ámbitos incompatibles, sustitución de contenido/discrepancias de hash, cobertura de respuestas genéricas, evidencias no relacionadas, marcadores de referencia filtrados, métricas de reporte alteradas y bloqueo de PASS cuando falla la verificación de la traza. Son pruebas simuladas o deterministas; no demuestran el comportamiento de una base de datos real.

### Validación local más reciente

| Comprobación | Resultado |
|---|---|
| `npm.cmd run typecheck --workspace=@sentinelops/api` | Aprobado (exit 0) |
| `npm.cmd test --workspace=@sentinelops/api` | 132 aprobadas, 0 fallidas |
| `npm.cmd run build --workspace=@sentinelops/api` | Aprobado (exit 0) |
| `git diff --check` | Aprobado |
| Preflight de solo lectura de INC-001 | Bloqueado de forma segura: daemon Docker e imagen PostgreSQL local no disponibles; falta `services/ai-orchestrator/.venv` |
| Preflight de Ollama | Disponible; se listaron `qwen3.5:4b` y `qwen3-embedding:0.6b`; no se ejecutaron inferencias |
| `test:postgres`, migraciones 001–008, runner aislado y evaluación INC-001 | No ejecutados |

La migración 008 y el runner de integración PostgreSQL incluyen ahora las tablas de trazas de recuperación, pero en esta validación no se aplicó ni ejercitó la migración. Aún requieren pruebas los casos de traza ausente, lineage entre proyectos distintos, documento no indexado, fuente inactiva, rechazo de evidencias de otros incidentes/ámbito de contexto del proyecto y relevancia adversarial de citas. Antes de aprobar el Reliability Gate siguen siendo obligatorios una ejecución de migraciones e integración en PostgreSQL temporal, una inferencia de Ollama, la evaluación INC-001 aislada y la verificación de limpieza. En esta validación no se accedió a la base PostgreSQL habitual ni a su volumen.

### Correcciones del contrato de investigación

Las investigaciones válidas ya no se regeneran por superar 220 palabras; el número de palabras se sigue registrando sin registrar el texto del modelo. El prompt indica las relaciones entre estados de hipótesis y referencias, que el backend sigue validando. El esquema compartido no incorpora condicionales cuya compatibilidad con el proveedor no se haya verificado.

El comando `npm.cmd run typecheck:runner --workspace=@sentinelops/api` comprueba el runner y sus pruebas con `strict`. La reconstrucción del evaluador de claims y citas permanece pendiente: sus reglas actuales no componen hechos atómicos y pueden clasificar incorrectamente la relevancia de E2. Las correcciones del contrato y de tipos no cierran INC-001 ni el Reliability Gate.

### Regresión parcial de OBS-05

En el flujo de reporte verificado, OBS-05 ya no cuenta como completa cuando faltan la persistencia, las 20 conexiones activas, las cero inactivas o las 31 solicitudes esperando; la prueba también comprueba que las mediciones de otro evento no completen el evento de 31 solicitudes. Esta comprobación conservadora exige actualmente que los componentes figuren en una sola línea de evidencia y en un solo claim, por lo que puede producir falsos negativos y aún no implementa la composición de claims atómicos. No demuestra una evaluación semántica general ni corrige las demás observaciones, las citas de hipótesis, E2 o las afirmaciones adicionales. Los tests del verificador utilizan datos simulados; no constituyen una nueva evaluación real ni aprueban INC-001.

### Base parcial para el evaluador V2

El extractor independiente de JSONL registra candidatos completos con identidad, hash y posiciones relativas al fragmento; informa líneas inválidas, incompletas o de otro incidente. No reconstruye registros entre fragmentos ni identifica por sí mismo el formato del documento. El reporte de verificación V1 solo vincula el estado al ID de evidencia, no a un hash en su resultado: el llamador debe conservar exactamente el manifiesto verificado. Las pruebas usan el dataset local y una traza simulada. El extractor todavía no está conectado al runner ni modifica métricas, contratos o aceptación; no existe aún un reporte V2.

Los offsets y metadatos actuales en PostgreSQL no son un snapshot de lo existente durante la recuperación. Para verificar históricamente esas propiedades se necesitaría, como propuesta aún no implementada, un almacenamiento aditivo de snapshot ligado a cada elemento de traza y su verificación, con pruebas de cambios posteriores, linaje, hash y compatibilidad histórica. Consultar los valores actuales no demuestra su estado histórico. No se modificó ninguna migración.

### Implementación de Evaluator V2 — pendiente de integración real

Se conectó el reporte `inc001-verified-v2` al runner aislado. La atestación por
evidencia contiene identidad, hashes, lineage, scope y metadatos leídos en la
consulta PostgreSQL; los errores globales ya no marcan falsamente como fallido
un item que supera sus comprobaciones individuales, aunque bloquean todo uso
posterior de la traza. El evaluador separa eventos JSONL, citas por aparición,
componentes OBS-01 a OBS-06 y soporte contextual de código estático.

En esta modificación pasaron los typechecks de API, runner y web. En la
validación inicial la suite API no se pudo iniciar porque Node devolvió
`uv_os_get_passwd: ENOMEM` al cargar `tsx`; ese fallo de host no se interpretó
como resultado de las pruebas. No se ejecutaron Docker, PostgreSQL,
migraciones, runner aislado ni INC-001, por lo que Phase 3.1 y el Reliability
Gate siguen bloqueados.

### Hardening de runtime y Evaluator V2 — 9 de noviembre de 2026

| Comprobación | Resultado |
|---|---|
| Diagnóstico Node | `node --version` y JavaScript simple funcionan; `os.userInfo()` y `tsx` fallan con `uv_os_get_passwd: ENOMEM`. No se pudo consultar la memoria del sistema desde este entorno, por lo que no se atribuye el fallo a falta de RAM. |
| Runner TypeScript local | API y runners pasan a Node nativo con `--experimental-transform-types` y un resolver local para especificadores relativos `.js` de TypeScript; se conserva `tsx` como dependencia, pero no se carga en esos comandos. |
| `npm.cmd test --workspace=@sentinelops/api` | 146 aprobadas, 0 fallidas. |
| `npm.cmd run typecheck --workspace=@sentinelops/api` | Aprobado. |
| `npm.cmd run typecheck:runner --workspace=@sentinelops/api` | Aprobado. |
| `npm.cmd run build --workspace=@sentinelops/api` | Aprobado. |
| `npm.cmd run typecheck --workspace=@sentinelops/web` | Aprobado. |
| `npm.cmd run build --workspace=@sentinelops/web` | Aprobado. |
| `git diff --check` | Aprobado. |
| Preflight aislado de INC-001 | Falló sin iniciar evaluación: daemon Docker no alcanzable, imagen `pgvector/pgvector:0.8.7-pg18-trixie` ausente y dependencias del entorno virtual del orquestador no importan. |
| Ollama en preflight | Disponible en `127.0.0.1:11434`; modelos `qwen3.5:4b` y `qwen3-embedding:0.6b` presentes. No se hicieron inferencias. |

El Evaluator V2 conserva cada evento JSONL y cada fragmento de código como un
contexto de evidencia separado. Una relación claim-evidence debe obtener sus
componentes de un único contexto; por ello OBS-02 y OBS-05 no se completan
mezclando los valores de eventos distintos. Para E2, el scanner exige la
constante `MAX_PARALLEL_ATTEMPTS = 5`, su uso dentro de la misma llamada a
`Array.from` que construye `attempts` y `Promise.all(attempts)` en la misma
función. Esto solo acredita configuración estática contextual: cualquier
afirmación de despliegue, ejecución o causalidad queda inválida. La validación
es determinista y no sustituye la ejecución real aislada.

El uso de `--experimental-transform-types` emite una advertencia de Node: es
un workaround local, no evidencia de estabilidad de una API definitiva. El
preflight no creó ni eliminó contenedores, no aplicó migraciones, no modificó
la base PostgreSQL habitual ni ejecutó la evaluación completa de INC-001.

### Misión 04 — primera evaluación aislada real de INC-001 — 9 de noviembre de 2026

Se ejecutaron dos evaluaciones reales con PostgreSQL temporal, Ollama local,
ingesta, embeddings de 1024 dimensiones, recuperación, attestation V2,
recomputación y reportes nuevos. Los resultados históricos se conservan en
`reports/inc001-isolated/` y no se sustituyen por este registro.

| Ejecución | Resultado verificable |
|---|---|
| `808c1ecbafdf62dddda89f00f3922190` | Falló en `investigation`: la llamada estructurada de chat agotó los 90 s (`HTTP 504`). La ingesta y los embeddings sí terminaron. Contenedor y volumen temporales se eliminaron; el reporte fue conservador y marcó el árbol API como `unknown`. |
| `d68349dce5c9a99f60c5fb54f574bc16` | El evaluator terminó (exit 0) y el reporte V2 fue válido, pero la calidad falló (exit 1). Cleanup verificado: evaluator, API y orquestador detenidos; contenedor y volumen anónimo eliminados. |

La segunda ejecución usó el puerto PostgreSQL temporal `50611`, no `5432`;
el contenedor tuvo etiquetas de propiedad del runner y el volumen habitual
`sentinelops-ai_postgres_data` permaneció presente. El contenedor habitual
`sentinelops-ai-postgres-1` siguió saludable en `127.0.0.1:5432`.

La primera ejecución demostró que los límites de 90 s del API y del
orquestador no eran compatibles con la generación JSON local: el API agotó
90.0 s y el orquestador 90.03 s. El runner aislado ahora inyecta límites
acotados de 300 s para Ollama, 305 s para la investigación API y 310 s para
la solicitud del evaluator; los valores por defecto de los servicios no se
ampliaron. El cleanup Windows reintenta una sola vez la inspección CIM de
descendientes y conserva `unknown` si tampoco puede demostrarla.

En la segunda ejecución, el reporte `inc001-verified-v2` verificó
procedencia, hashes y scope de las dos evidencias; `Retrieval Recall` fue
`1.0`, no hubo filtración de referencia ni violaciones deterministas de
factualidad. Sin embargo, `Answer Coverage` fue `1/6`; hubo 8 relaciones de
cita válidas, 1 parcial y 2 inválidas. La respuesta omitió componentes
requeridos (incluidos cero conexiones inactivas, HTTP 500, duración de 180 ms
y el conjunto completo de la observación de saturación persistente) y su
resumen afirmó causalidad no demostrada. El prompt ya pedía hechos atómicos,
valores, ceros, duraciones y no afirmar causalidad por correlación; por tanto
el fallo se atribuye a la salida real del modelo, no se corrige alterando el
ground truth ni reduciendo el gate. No se realizó un tercer intento para
seleccionar una salida favorable.

### Misión 05 — recuperación semántica y recomputación histórica — 10 de noviembre de 2026

La recomputación determinista del reporte histórico
`2026-11-10T01-39-16-264Z/evaluation.json` conserva sus entradas y confirma
que la recuperación fue completa. El informe de comparación nuevo en
`reports/inc001-isolated/mission-05-historical-recomputation.json` no altera
el reporte original: corrige dos falsos negativos verificables del evaluador
(la formulación `timeout de adquisición de conexión` y la profundidad de una
cola expresada mediante lenguaje natural). Con los mismos datos, OBS-04 pasa a
estar completa y la cobertura sube de 1/6 a 2/6; no es una mejora de
generación. OBS-02, OBS-03, OBS-05 y OBS-06 continúan incompletas por
componentes omitidos o por contextos de eventos que no se pueden fusionar.

La generación incorpora un inventario auxiliar de registros JSONL completos,
derivado únicamente de la evidencia recuperada y con identidad de evidencia,
proyecto, incidente y offsets de cada registro. El inventario no contiene el
ground truth ni construye una respuesta: instruye al modelo a conservar los
campos de un mismo registro sin combinarlos. También se exige que el resumen
sea cronológico y neutral; una afirmación causal puede aparecer únicamente
como hipótesis explícitamente no confirmada. El evaluador ahora registra como
violación la atribución de la saturación a intentos concurrentes cuando se
presenta como hecho, sin reescribir el texto del modelo.

| Comprobación | Resultado |
|---|---|
| Recomputación de los artefactos históricos | PASS determinista; el resultado sigue siendo `passed: false` |
| `npm.cmd test --workspace=@sentinelops/api` | 148 aprobadas, 0 fallidas |
| Pruebas del orquestador | 35 aprobadas, 0 fallidas |
| Typecheck API y runner; build API | PASS |
| Typecheck y build web | PASS |
| `git diff --check` | PASS |
| Preflight aislado posterior | FAIL seguro: el daemon Docker no estaba alcanzable desde este entorno; no se inició ningún recurso temporal |

El preflight posterior siguió encontrando Ollama y ambos modelos, el entorno
virtual del orquestador y puertos loopback disponibles. No se hizo una nueva
evaluación real: su autorización exige preflight e aislamiento correctos, y
el daemon ausente no permite verificarlos. No se reinició Docker, no se
modificó `.env`, PostgreSQL habitual ni sus volúmenes, y no se alteró el
ground truth ni los umbrales. INC-001 y el Reliability Gate permanecen
abiertos.
