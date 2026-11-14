import {
  formatObservationValue,
  labelForProperty,
  type InvestigationEvidenceReference,
  type InvestigationObservation,
  type InvestigationPresentation,
} from "@/lib/investigation-presentation";
import type { DirectedInvestigationView } from "@/lib/directed-investigation";

interface InvestigationReportProps {
  presentation: InvestigationPresentation;
  directedQuery: DirectedInvestigationView | null;
  onSelectEvidence: (evidenceId: string) => void;
  onFocusFact: (factId: string) => void;
  onFocusEvent: (eventId: string) => void;
  onShowFullReport: () => void;
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
  onFocusEvent,
  anchorFacts = false,
}: {
  observations: InvestigationObservation[];
  onSelectEvidence: (evidenceId: string) => void;
  onFocusEvent: (eventId: string) => void;
  anchorFacts?: boolean;
}) {
  return (
    <ul className="report-fact-list">
      {observations.map((observation, index) => (
        <li
          id={anchorFacts ? `fact-${observation.factId}` : undefined}
          key={`${observation.factId}:${index}`}
          tabIndex={anchorFacts ? -1 : undefined}
        >
          <div className="report-fact-value">
            <span>{labelForProperty(observation.property)}</span>
            <strong>{formatObservationValue(observation)}</strong>
          </div>
          <div className="report-fact-provenance">
            <code>{observation.property}</code>
            <button
              className="report-context-link"
              onClick={() => onFocusEvent(observation.eventId)}
              type="button"
            >
              Consultar evento
            </button>
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

function FactNavigationList({
  facts,
  onFocusFact,
}: {
  facts: InvestigationObservation[];
  onFocusFact: (factId: string) => void;
}) {
  return (
    <ul className="report-context-fact-links">
      {facts.map((fact) => (
        <li key={fact.factId}>
          <button
            className="report-context-link"
            onClick={() => onFocusFact(fact.factId)}
            type="button"
          >
            {labelForProperty(fact.property)}: {formatObservationValue(fact)} [{fact.evidenceAlias}]
          </button>
        </li>
      ))}
    </ul>
  );
}

function IndicatorCards({
  indicators,
  onFocusFact,
  onSelectEvidence,
}: {
  indicators: InvestigationObservation[];
  onFocusFact: (factId: string) => void;
  onSelectEvidence: (evidenceId: string) => void;
}) {
  return (
    <div className="report-indicator-grid">
      {indicators.map((indicator, index) => (
        <article className="report-indicator" key={`${indicator.factId}:${index}`}>
          <span>{labelForProperty(indicator.property)}</span>
          <strong>{formatObservationValue(indicator)}</strong>
          <small>{indicator.context.timestamp ?? "Timestamp no disponible"}</small>
          <div className="report-indicator-actions">
            <button
              className="report-context-link"
              onClick={() => onFocusFact(indicator.factId)}
              type="button"
            >
              Consultar hecho
            </button>
            <button
              className="citation-link"
              onClick={() => onSelectEvidence(indicator.evidenceId)}
              type="button"
            >
              [{indicator.evidenceAlias}]
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function DirectedQueryPanel({
  query,
  onFocusFact,
  onFocusEvent,
  onSelectEvidence,
  onShowFullReport,
}: {
  query: DirectedInvestigationView;
  onFocusFact: (factId: string) => void;
  onFocusEvent: (eventId: string) => void;
  onSelectEvidence: (evidenceId: string) => void;
  onShowFullReport: () => void;
}) {
  return (
    <section className="report-section report-directed-query" aria-labelledby="directed-query-title">
      <div className="report-section-heading">
        <div>
          <p className="panel-kicker">FILTRO DETERMINISTA LIMITADO</p>
          <h4 id="directed-query-title">{query.title}</h4>
        </div>
        <span className={`report-query-status report-query-status--${query.status}`}>
          {query.status === "resolved" ? "Vista respaldada" : "Informe general"}
        </span>
      </div>
      <p className="report-query-question">Pregunta original: “{query.originalQuestion}”</p>
      <p className="report-query-message">{query.message}</p>

      {query.status === "resolved" ? (
        <div className="report-query-results">
          {query.facts.length > 0 ? (
            <details>
              <summary>{query.facts.length} {query.facts.length === 1 ? "hecho relacionado" : "hechos relacionados"}</summary>
              <FactNavigationList facts={query.facts} onFocusFact={onFocusFact} />
            </details>
          ) : null}
          {query.events.length > 0 ? (
            <details>
              <summary>{query.events.length} {query.events.length === 1 ? "evento relacionado" : "eventos relacionados"}</summary>
              <ul className="report-context-event-links">
                {query.events.map((event) => (
                  <li key={event.eventId}>
                    <button
                      className="report-context-link"
                      onClick={() => onFocusEvent(event.eventId)}
                      type="button"
                    >
                      {eventTitle(event.observations[0])}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {query.evidence.length > 0 ? (
            <div className="report-query-evidence">
              <span>Evidencias relacionadas:</span>
              <EvidenceReferences
                evidence={query.evidence}
                onSelectEvidence={onSelectEvidence}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        className="report-context-link report-full-report-link"
        onClick={onShowFullReport}
        type="button"
      >
        Consultar informe completo
      </button>
    </section>
  );
}

export function InvestigationReport({
  presentation,
  directedQuery,
  onSelectEvidence,
  onFocusFact,
  onFocusEvent,
  onShowFullReport,
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
        <div className="report-contextual-summary">
          <p>{presentation.contextualSummary.observedSummary}</p>
          {presentation.contextualSummary.statements.length > 0 ? (
            <ul className="report-contextual-statements" aria-label="Condiciones observadas">
              {presentation.contextualSummary.statements.map((statement) => (
                <li key={statement.key}>
                  <p>{statement.text}</p>
                  <FactNavigationList facts={statement.facts} onFocusFact={onFocusFact} />
                  <EvidenceReferences
                    evidence={statement.evidence}
                    onSelectEvidence={onSelectEvidence}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="report-summary-uncertainty">
            <strong>Incertidumbre:</strong> {presentation.contextualSummary.uncertainty}
          </div>
          {presentation.contextualSummary.missingInformation.length > 0 ? (
            <div className="report-summary-missing">
              <strong>Información que falta para confirmarla:</strong>
              <ul>
                {presentation.contextualSummary.missingInformation.map((item, index) => (
                  <li key={`${item}:${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="report-summary-evidence">
          <span>Evidencia consultable:</span>
          <EvidenceReferences
            evidence={presentation.summary.evidence}
            onSelectEvidence={onSelectEvidence}
          />
        </div>
      </section>

      {directedQuery ? (
        <DirectedQueryPanel
          query={directedQuery}
          onFocusFact={onFocusFact}
          onFocusEvent={onFocusEvent}
          onSelectEvidence={onSelectEvidence}
          onShowFullReport={onShowFullReport}
        />
      ) : null}

      {presentation.highlightedIndicators.length > 0 ? (
        <section className="report-section" aria-labelledby="report-indicators-title">
          <div className="report-section-heading">
            <div>
              <p className="panel-kicker">MEDICIONES ATESTADAS</p>
              <h4 id="report-indicators-title">Indicadores destacados</h4>
            </div>
            <span className="report-section-count">{presentation.highlightedIndicators.length}</span>
          </div>
          <IndicatorCards
            indicators={presentation.highlightedIndicators}
            onFocusFact={onFocusFact}
            onSelectEvidence={onSelectEvidence}
          />
          <p className="report-section-note">
            Cada tarjeta representa una medición individual; no se combinan eventos para inferir tendencias o ratios.
          </p>
          {presentation.indicators.length > presentation.highlightedIndicators.length ? (
            <details className="report-all-measurements">
              <summary>Ver todas las mediciones atestadas ({presentation.indicators.length})</summary>
              <IndicatorCards
                indicators={presentation.indicators}
                onFocusFact={onFocusFact}
                onSelectEvidence={onSelectEvidence}
              />
            </details>
          ) : null}
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
                          onFocusEvent={onFocusEvent}
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

      <section className="report-section" id="report-full-details" aria-labelledby="report-facts-title">
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
              <details className="report-event-fact-group" id={`event-${event.eventId}`} key={event.eventId}>
                <summary>{eventTitle(event.observations[0])}</summary>
                <FactList
                  observations={event.observations}
                  onSelectEvidence={onSelectEvidence}
                  onFocusEvent={onFocusEvent}
                  anchorFacts
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
