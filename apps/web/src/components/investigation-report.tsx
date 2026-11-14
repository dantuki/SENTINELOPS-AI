import {
  formatObservationValue,
  labelForProperty,
  type InvestigationEvidenceReference,
  type InvestigationObservation,
  type InvestigationPresentation,
} from "@/lib/investigation-presentation";

interface InvestigationReportProps {
  presentation: InvestigationPresentation;
  onSelectEvidence: (evidenceId: string) => void;
}

function EvidenceReferences({
  evidence,
  onSelectEvidence,
}: {
  evidence: InvestigationEvidenceReference[];
  onSelectEvidence: (evidenceId: string) => void;
}) {
  if (evidence.length === 0) {
    return <span className="report-missing-reference">Sin referencia recuperada</span>;
  }

  return (
    <span className="report-evidence-references" aria-label="Evidencias relacionadas">
      {evidence.map((reference) => (
        <button
          className="citation-link"
          key={reference.evidenceId}
          onClick={() => onSelectEvidence(reference.evidenceId)}
          type="button"
        >
          [{reference.alias}]
        </button>
      ))}
    </span>
  );
}

function eventTitle(observation: InvestigationObservation): string {
  const parts = [
    observation.context.service,
    observation.context.event,
    observation.context.timestamp,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(" · ") : "Evento sin contexto temporal verificable";
}

function FactList({
  observations,
  onSelectEvidence,
}: {
  observations: InvestigationObservation[];
  onSelectEvidence: (evidenceId: string) => void;
}) {
  return (
    <ul className="report-fact-list">
      {observations.map((observation, index) => (
        <li key={`${observation.factId}:${index}`}>
          <div className="report-fact-value">
            <span>{labelForProperty(observation.property)}</span>
            <strong>{formatObservationValue(observation)}</strong>
          </div>
          <div className="report-fact-provenance">
            <code>{observation.property}</code>
            <button
              className="citation-link"
              onClick={() => onSelectEvidence(observation.evidenceId)}
              type="button"
            >
              [{observation.evidenceAlias}]
            </button>
          </div>
          <details className="report-technical-details">
            <summary>Detalles técnicos verificables</summary>
            <dl>
              <div>
                <dt>Hecho</dt>
                <dd><code>{observation.factId}</code></dd>
              </div>
              <div>
                <dt>Evento</dt>
                <dd><code>{observation.eventId}</code></dd>
              </div>
              <div>
                <dt>Fuente</dt>
                <dd>
                  Línea {observation.sourceLocator.line}; bytes {observation.sourceLocator.startOffset}–{observation.sourceLocator.endOffset}
                </dd>
              </div>
              <div>
                <dt>Hash del registro</dt>
                <dd><code>{observation.sourceLocator.recordContentHash}</code></dd>
              </div>
              {observation.context.incidentRequestId ? (
                <div>
                  <dt>request_id</dt>
                  <dd><code>{observation.context.incidentRequestId}</code></dd>
                </div>
              ) : null}
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function InvestigationReport({
  presentation,
  onSelectEvidence,
}: InvestigationReportProps) {
  return (
    <section className="investigation-report" aria-labelledby="investigation-report-title">
      <header className="investigation-report-heading">
        <div>
          <p className="panel-kicker">INFORME DETERMINISTA</p>
          <h3 id="investigation-report-title">Resumen de la investigación</h3>
        </div>
        <span className={`report-gate report-gate--${presentation.metadata.gateStatus}`}>
          Gate V2: {presentation.metadata.gateStatus}
        </span>
      </header>

      <section className="report-section report-summary" aria-labelledby="report-summary-title">
        <div className="report-section-heading">
          <div>
            <p className="panel-kicker">CONTEXTO Y LÍMITES</p>
            <h4 id="report-summary-title">Resumen de la investigación</h4>
          </div>
          <span className="report-root-cause">Causa raíz: sin confirmar</span>
        </div>
        <dl className="report-context">
          <div>
            <dt>Incidente</dt>
            <dd>{presentation.incident.reference} · {presentation.incident.title}</dd>
          </div>
          {presentation.incident.serviceName ? (
            <div>
              <dt>Servicio</dt>
              <dd>{presentation.incident.serviceName}</dd>
            </div>
          ) : null}
          <div>
            <dt>Modo</dt>
            <dd>{presentation.metadata.mode}</dd>
          </div>
          <div>
            <dt>Evidencias recuperadas</dt>
            <dd>{presentation.summary.retrievedEvidenceCount}</dd>
          </div>
          <div>
            <dt>Enriquecimiento IA</dt>
            <dd>{presentation.metadata.aiEnrichmentStatus}</dd>
          </div>
        </dl>
        <p>{presentation.summary.text}</p>
        {presentation.summary.conditions.length > 0 ? (
          <ul className="report-summary-conditions" aria-label="Condiciones observadas">
            {presentation.summary.conditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        ) : null}
        <div className="report-summary-evidence">
          <span>Evidencia consultable:</span>
          <EvidenceReferences
            evidence={presentation.summary.evidence}
            onSelectEvidence={onSelectEvidence}
          />
        </div>
      </section>

      {presentation.indicators.length > 0 ? (
        <section className="report-section" aria-labelledby="report-indicators-title">
          <div className="report-section-heading">
            <div>
              <p className="panel-kicker">MEDICIONES ATESTADAS</p>
              <h4 id="report-indicators-title">Indicadores observados</h4>
            </div>
            <span className="report-section-count">{presentation.indicators.length}</span>
          </div>
          <div className="report-indicator-grid">
            {presentation.indicators.map((indicator, index) => (
              <article className="report-indicator" key={`${indicator.factId}:${index}`}>
                <span>{labelForProperty(indicator.property)}</span>
                <strong>{formatObservationValue(indicator)}</strong>
                <small>
                  {indicator.context.timestamp ?? "Timestamp no disponible"}
                </small>
                <button
                  className="citation-link"
                  onClick={() => onSelectEvidence(indicator.evidenceId)}
                  type="button"
                >
                  [{indicator.evidenceAlias}]
                </button>
              </article>
            ))}
          </div>
          <p className="report-section-note">
            Cada tarjeta representa una medición individual; no se combinan eventos para inferir tendencias o ratios.
          </p>
        </section>
      ) : null}

      <section className="report-section" aria-labelledby="report-patterns-title">
        <div className="report-section-heading">
          <div>
            <p className="panel-kicker">REGLAS APLICADAS A HECHOS</p>
            <h4 id="report-patterns-title">Patrones detectados</h4>
          </div>
          <span className="report-section-count">
            {presentation.patternGroups.reduce(
              (count, group) => count + group.instances.length,
              0,
            )}
          </span>
        </div>
        {presentation.patternGroups.length > 0 ? (
          <div className="report-pattern-groups">
            {presentation.patternGroups.map((group) => (
              <details className="report-pattern-group" key={group.ruleId}>
                <summary>
                  <span>{group.label}</span>
                  <span>{group.instances.length} {group.instances.length === 1 ? "observación" : "observaciones"}</span>
                </summary>
                <ol>
                  {group.instances.map((instance) => (
                    <li key={instance.key}>
                      <p>{instance.description}</p>
                      {instance.matchedFacts.length > 0 ? (
                        <FactList
                          observations={instance.matchedFacts}
                          onSelectEvidence={onSelectEvidence}
                        />
                      ) : (
                        <p className="report-conservative-note">
                          La respuesta no expuso los hechos asociados a esta instancia; se conserva la referencia del patrón sin inferir relaciones adicionales.
                        </p>
                      )}
                      <div className="report-pattern-links">
                        <span>Evidencia:</span>
                        <EvidenceReferences
                          evidence={instance.evidence}
                          onSelectEvidence={onSelectEvidence}
                        />
                      </div>
                      <details className="report-technical-details">
                        <summary>Identidades de hechos coincidentes</summary>
                        <ul className="report-identity-list">
                          {instance.matchedFactIds.map((factId, index) => (
                            <li key={`${factId}:${index}`}><code>{factId}</code></li>
                          ))}
                          {instance.missingFactIds.map((factId, index) => (
                            <li key={`missing:${factId}:${index}`}>
                              <code>{factId}</code> (no expuesto en observaciones)
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        ) : (
          <p className="report-empty">No se aplicó una regla con evidencia suficiente.</p>
        )}
      </section>

      <section className="report-section" aria-labelledby="report-unconfirmed-title">
        <div className="report-section-heading">
          <div>
            <p className="panel-kicker">INCERTIDUMBRE EXPLÍCITA</p>
            <h4 id="report-unconfirmed-title">Qué sigue sin confirmarse</h4>
          </div>
        </div>
        {presentation.unconfirmed.length > 0 ? (
          <ul className="report-text-list">
            {presentation.unconfirmed.map((item, index) => (
              <li key={`${item}:${index}`}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="report-empty">La respuesta no incluyó una hipótesis o limitación adicional.</p>
        )}
      </section>

      <section className="report-section" aria-labelledby="report-checks-title">
        <div className="report-section-heading">
          <div>
            <p className="panel-kicker">SIGUIENTES PASOS MANUALES</p>
            <h4 id="report-checks-title">Qué comprobar después</h4>
          </div>
        </div>
        {presentation.recommendedChecks.length > 0 ? (
          <ul className="report-text-list">
            {presentation.recommendedChecks.map((check, index) => (
              <li key={`${check}:${index}`}>{check}</li>
            ))}
          </ul>
        ) : (
          <p className="report-empty">No se recibieron comprobaciones recomendadas.</p>
        )}
      </section>

      <section className="report-section" aria-labelledby="report-facts-title">
        <div className="report-section-heading">
          <div>
            <p className="panel-kicker">HECHOS ATESTADOS</p>
            <h4 id="report-facts-title">Qué sabemos</h4>
          </div>
          <span className="report-section-count">
            {presentation.eventFacts.reduce(
              (count, event) => count + event.observations.length,
              0,
            )}
          </span>
        </div>
        {presentation.eventFacts.length > 0 ? (
          <div className="report-event-facts">
            {presentation.eventFacts.map((event) => (
              <details className="report-event-fact-group" key={event.eventId}>
                <summary>{eventTitle(event.observations[0])}</summary>
                <FactList
                  observations={event.observations}
                  onSelectEvidence={onSelectEvidence}
                />
              </details>
            ))}
          </div>
        ) : (
          <p className="report-empty">No hay hechos verificados disponibles para mostrar.</p>
        )}
      </section>
    </section>
  );
}
