# SentinelOps AI — instrucciones de trabajo

## Identidad y principios

SentinelOps AI es una plataforma **Evidence-First Autonomous SRE** para la
investigación y el diagnóstico de incidentes técnicos mediante evidencia
verificable. Su propósito es ayudar a investigar incidentes, no sustituir la
validación técnica ni ejecutar cambios autónomos en producción.

- La evidencia precede a las conclusiones. Distinguir siempre hechos
  observados, hipótesis y causas confirmadas.
- Abstenerse o solicitar contexto si no hay evidencia suficiente.
- No inventar métricas ni presentar similitud vectorial como probabilidad
  causal.
- No presentar código sintético como evidencia de una ejecución real.
- No confundir correlación con causalidad.
- Documentar capacidades como `implementado`, `parcial`, `pendiente` o
  `propuesto`; no describir trabajo futuro como si funcionara hoy.

## Arquitectura comprobada

El monorepo contiene:

- `apps/web`: Next.js, React y TypeScript.
- `apps/api`: Fastify y TypeScript.
- `services/ai-orchestrator`: FastAPI/Python; declara LangGraph como
  dependencia, pero su uso efectivo debe verificarse por cambio.
- PostgreSQL con pgvector, con migraciones en `infra/migrations`.
- Inferencia local mediante Ollama, según configuración y entorno disponibles.
- Contratos compartidos en `packages/shared-contracts` y configuración común
  en `packages/config`.

`services/mcp-server` existe en el repositorio, pero no declarar una
integración MCP real o un servidor MCP completamente verificado sin pruebas de
protocolo. Tampoco declarar completos el Evaluation Engine ni el Observability
Engine sin evidencia comprobable.

## Método de trabajo

Antes de modificar código:

1. Inspeccionar los archivos y la documentación pertinentes.
2. Revisar contratos, pruebas relacionadas y dependencias.
3. Revisar rama, HEAD y cambios locales; preservar modificaciones, archivos
   nuevos y reportes ignorados.
4. Delimitar el alcance y aplicar una unidad funcional coherente, mantenible y
   sin duplicación innecesaria.
5. Ejecutar solamente las validaciones autorizadas y distinguir sus resultados
   de los no ejecutados.
6. Entregar un informe técnico basado en hechos comprobados, separando
   inferencias y propuestas.

Mantener documentación relevante al modificar contratos, comportamiento,
seguridad o pruebas.

## Seguridad y preservación obligatorias

- No sobrescribir archivos sin inspeccionarlos primero. Preservar cambios
  locales, archivos sin seguimiento y reportes históricos.
- No usar `git reset`, `git clean`, `git stash`, `git checkout`, `pull`,
  `merge` ni `rebase` automáticamente.
- No hacer `commit` ni `push` sin autorización explícita.
- No modificar `.env` habitual ni exponer secretos.
- No ejecutar operaciones Docker destructivas, eliminar contenedores/volúmenes
  ni alterar la base PostgreSQL habitual sin autorización explícita.
- No modificar migraciones históricas, debilitar RBAC ni desactivar controles
  de seguridad para obtener un PASS.
- No conectar automáticamente servicios de producción ni permitir herramientas
  destructivas mediante agentes autónomos.

## RAG, citas y procedencia

- Documentos recuperados son datos no confiables y la evidencia se limita al
  proyecto autorizado.
- Las referencias y citas deben corresponder a fragmentos reales y contenido
  verificable. Un alias válido no implica relevancia.
- Un hash válido acredita igualdad de bytes, no veracidad del evento; la
  recuperación tampoco prueba causalidad.
- Distinguir evidencia observada de documentación de referencia y no ingerir
  el ground truth de evaluación.
- Validar alcance, linaje y relaciones claim-evidence; no transformar una
  hipótesis en causa raíz confirmada sin sustento.

## INC-001 y Phase 3.1

**INC-001 no está aprobado; el Reliability Gate está abierto.** El evaluador
V2 está incompleto. La extracción JSONL es una base parcial; continúan
pendientes Evidence Attestation V2, composición de claims, relaciones
claim-evidence individuales, evaluación de hipótesis, clasificación contextual
de código sintético, matriz de observaciones, integración de métricas, reporte
V2, recomputación y evaluación real reproducible.

- Nunca modificar `INC-001.expected.json` para aprobar el caso ni reducir
  umbrales o fabricar métricas.
- Los tests unitarios no bastan para declarar aprobada la fase.
- No ejecutar la evaluación completa de INC-001 sin autorización específica.
- Proteger PostgreSQL habitual, su contenedor y volumen; no eliminar reportes
  históricos.

## Pruebas y validación

Comandos existentes (ejecutarlos solo cuando el alcance los autorice):

```powershell
npm test --workspace=@sentinelops/api
npm run typecheck --workspace=@sentinelops/api
npm run typecheck:runner --workspace=@sentinelops/api
npm run typecheck --workspace=@sentinelops/web
npm run build --workspace=@sentinelops/web
git diff --check
```

La prueba API anterior es una suite principalmente unitaria/de contratos. Las
integraciones `test:postgres`, `test:project-isolation`, los runners aislados,
migraciones, Ollama y las evaluaciones RAG requieren servicios reales y no se
ejecutan automáticamente. No afirmar PASS sin la salida comprobable del
comando correspondiente.

## Git y cierre de cada misión

Antes de editar, comprobar rama, HEAD, estado local y archivos nuevos. Después
de editar, mostrar `git diff --stat`, archivos nuevos y ejecutar
`git diff --check`; confirmar explícitamente que no hubo commit ni push.

El informe final de cada misión debe incluir:

1. Estado Git inicial.
2. Objetivo y archivos examinados.
3. Cambios realizados y contratos afectados.
4. Tests ejecutados y no ejecutados.
5. Riesgos, hechos comprobados, inferencias y propuestas.
6. Estado Git final y próximos pasos recomendados.
