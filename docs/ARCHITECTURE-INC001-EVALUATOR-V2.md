# INC-001 Evaluator V2

## Estado

**Implementado parcialmente y conectado al runner aislado.** Este documento no
declara aprobado INC-001 ni cerrado el Reliability Gate. La validación con
PostgreSQL temporal, Ollama e investigación real sigue pendiente de un
preflight que permita ejecutar infraestructura aislada.

## Flujo

1. Product API persiste el manifiesto de recuperación y sus items.
2. El runner consulta la traza con un pool PostgreSQL temporal de solo lectura.
3. `RetrievalTraceVerifier` emite la atestación V2 para cada evidencia y el
   estado global de la traza.
4. El evaluador V2 extrae eventos JSONL sin unir fragmentos y analiza código
   TypeScript con el scanner estructural disponible en TypeScript 7.
5. Evalúa cada aparición `claim + referencia + evidencia`, compone
   componentes de OBS-01 a OBS-06 y recalcula métricas y aceptación.
6. El runner escribe un reporte `inc001-verified-v2` solo después de comparar
   el candidato con el manifiesto, la traza y la recomputación.

## Evidence Attestation V2

Por cada item se informa identidad canónica, `runId`, `retrievalRequestId`,
proyecto, incidente solicitado, rank, ordinal, hashes esperado/almacenado/
recalculado, coincidencia de contenido y hash, lineage, estados y scope.
También se exponen metadatos disponibles en las filas actuales: título, media
type, source document key, source type, offsets del chunk y JSON metadata.

Los datos de la atestación se leen de PostgreSQL durante la verificación. Una
traza global fallida bloquea todo uso evaluable, aunque el diagnóstico de un
item individual no se contamina con errores acumulados de otro item.

La atestación demuestra consistencia con las filas y el registro de
recuperación consultados; no es una firma externa ni una garantía de
inmutabilidad histórica. Los metadatos actuales no constituyen un snapshot del
momento de recuperación.

## Eventos, claims y código

`requestId` de recuperación y `incidentRequestId` extraído de JSONL son tipos
y campos distintos. La identidad de un evento incluye chunk canónico, offset
UTF-16 relativo y hash del registro; no depende solamente del timestamp,
contenido o incident ID.

Cada cita se clasifica individualmente como `valid`, `partial`, `invalid` o
`not_evaluable`. Una cita válida para un claim no valida otra aparición del
mismo alias. Cada evento JSONL y cada fragmento de código es un contexto
separado: todos los componentes de una relación deben proceder del mismo
contexto, sin mezclar mediciones de eventos diferentes.

La evidencia de código solo otorga soporte contextual a propiedades estáticas
cuando el scanner encuentra `MAX_PARALLEL_ATTEMPTS = 5`, su uso dentro de la
misma llamada `Array.from` que construye `attempts`, y
`Promise.all(attempts)` en la misma función `dispatchOrderRetries`. Los
comentarios y una constante usada en otra expresión no bastan. Esta regla
estructural es deliberadamente estrecha y no es un análisis de flujo completo;
si no se demuestra esa relación, el componente no se acredita. Nunca demuestra
despliegue, ejecución ni causalidad.

OBS-02 y OBS-05 se mantienen separadas por sus componentes de evento: la
medición de 18 solicitudes esperando no completa la medición posterior de 31.
El reporte incluye matrices de evidencia, claim-evidence y observaciones, más
las métricas recomputadas de recall, coverage, citas, soporte, factualidad,
contradicciones, abstención, filtración de referencia y procedencia.

## Aceptación

El evaluador conserva un gate conservador: requiere procedencia global
verificada, `Retrieval Recall = 1`, `Answer Coverage = 1`, relaciones de cita
sin errores, ausencia de afirmaciones factuales no soportadas, contradicciones
sin resolver, violaciones deterministas y filtración del reference dataset.
Los reportes V1 históricos permanecen sin reinterpretación silenciosa; las
nuevas finalizaciones usan `inc001-verified-v2`.
