
# SentinelOps AI — Plan de pruebas

## 1. Propósito

Este documento define la estrategia de pruebas para SentinelOps AI.

El objetivo es verificar la funcionalidad, integración, seguridad y calidad de los resultados del sistema mediante comprobaciones reproducibles.

Las pruebas deberán demostrar comportamientos concretos. No se considerará suficiente que una pantalla parezca funcionar o que un modelo produzca una respuesta convincente.

**Estado:** plan inicial. Las pruebas se implementarán y ejecutarán durante las fases correspondientes.

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
- Suite de pruebas implementada: no.
- Suite de pruebas ejecutada: no.
- Integración MCP verificada: no.
- Pipeline RAG verificado: no.
- Pruebas de seguridad ejecutadas: no.
- Benchmark de IA ejecutado: no.

Estos estados cambiarán únicamente cuando existan implementaciones y resultados verificables.
