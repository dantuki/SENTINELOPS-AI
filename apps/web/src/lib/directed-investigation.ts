import type {
  InvestigationEvidenceReference,
  InvestigationObservation,
  InvestigationPresentation,
  PresentationEventFacts,
} from "./investigation-presentation.ts";

export type DirectedQueryIntent =
  | "timeline"
  | "errors"
  | "capacity"
  | "retries"
  | "evidence"
  | "unknown";

export type DirectedQueryStatus =
  | "resolved"
  | "unknown"
  | "ambiguous"
  | "unavailable";

export interface DirectedQueryRecognition {
  intent: DirectedQueryIntent;
  matchedIntents: Exclude<DirectedQueryIntent, "unknown">[];
}

export interface DirectedInvestigationView {
  originalQuestion: string;
  status: DirectedQueryStatus;
  intent: DirectedQueryIntent;
  matchedIntents: Exclude<DirectedQueryIntent, "unknown">[];
  title: string;
  message: string;
  facts: InvestigationObservation[];
  events: PresentationEventFacts[];
  evidence: InvestigationEvidenceReference[];
}

const intentLabels: Record<Exclude<DirectedQueryIntent, "unknown">, string> = {
  timeline: "cronología",
  errors: "errores y fallos",
  capacity: "capacidad y saturación",
  retries: "reintentos",
  evidence: "evidencias y procedencia",
};

const intentRules: Array<{
  intent: Exclude<DirectedQueryIntent, "unknown">;
  expression: RegExp;
}> = [
  {
    intent: "timeline",
    expression: /\b(?:cronologia|secuencia|orden temporal|timeline|cuando)\b/u,
  },
  {
    intent: "errors",
    expression: /\b(?:error(?:es)?|fallo(?:s)?|http\s*(?:5\d\d|5xx)|status(?: code)?|codigo(?: http)?)\b/u,
  },
  {
    intent: "capacity",
    expression: /\b(?:capacidad|saturacion|conexiones?|pool|inactiva|limite)\b/u,
  },
  {
    intent: "retries",
    expression: /\b(?:reintentos?|intentos? adicionales?)\b/u,
  },
  {
    intent: "evidence",
    expression: /\b(?:evidencias?|fuentes?|procedencia|provenance)\b/u,
  },
];

const ruleIdsForIntent: Partial<
  Record<Exclude<DirectedQueryIntent, "unknown" | "timeline" | "evidence">, string[]>
> = {
  errors: ["http-5xx-observed", "timeout-observed"],
  capacity: ["capacity-at-limit", "no-idle-capacity"],
  retries: ["retries-observed"],
};

function normalizeQuestion(question: string): string {
  return question
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-CO");
}

function uniqueById<T extends { factId: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.factId)) return false;
    seen.add(item.factId);
    return true;
  });
}

function uniqueEvidence(
  evidence: readonly InvestigationEvidenceReference[],
): InvestigationEvidenceReference[] {
  const seen = new Set<string>();
  return evidence.filter((reference) => {
    if (seen.has(reference.evidenceId)) return false;
    seen.add(reference.evidenceId);
    return true;
  });
}

function selectedEvidence(
  presentation: InvestigationPresentation,
  facts: readonly InvestigationObservation[],
): InvestigationEvidenceReference[] {
  const evidenceById = new Map(
    presentation.evidence.map((reference) => [reference.evidenceId, reference]),
  );

  return uniqueEvidence(
    facts.flatMap((fact) => {
      const evidence = evidenceById.get(fact.evidenceId);
      return evidence ? [evidence] : [];
    }),
  );
}

function eventsFor(
  presentation: InvestigationPresentation,
  facts: readonly InvestigationObservation[],
): PresentationEventFacts[] {
  const eventIds = new Set(facts.map((fact) => fact.eventId));
  return presentation.eventFacts.filter((event) => eventIds.has(event.eventId));
}

export function recognizeDirectedQuery(question: string): DirectedQueryRecognition {
  const normalized = normalizeQuestion(question);
  const matchedIntents = intentRules
    .filter(({ expression }) => expression.test(normalized))
    .map(({ intent }) => intent);

  if (matchedIntents.length !== 1) {
    return { intent: "unknown", matchedIntents };
  }

  return { intent: matchedIntents[0], matchedIntents };
}

/**
 * Creates a transparent local view over an already attested result. It does
 * not issue a request, generate a response, or derive causal relationships.
 */
export function createDirectedInvestigationView(
  presentation: InvestigationPresentation,
  question: string,
): DirectedInvestigationView {
  const recognition = recognizeDirectedQuery(question);

  if (recognition.matchedIntents.length === 0) {
    return {
      originalQuestion: question,
      status: "unknown",
      intent: "unknown",
      matchedIntents: [],
      title: "Consulta dirigida no disponible",
      message: "No se pudo resolver esta pregunta mediante las consultas deterministas disponibles. Se muestra el informe general basado en evidencias.",
      facts: [],
      events: [],
      evidence: [],
    };
  }

  if (recognition.matchedIntents.length > 1) {
    const labels = recognition.matchedIntents.map((intent) => intentLabels[intent]);
    return {
      originalQuestion: question,
      status: "ambiguous",
      intent: "unknown",
      matchedIntents: recognition.matchedIntents,
      title: "Consulta dirigida ambigua",
      message: `La pregunta coincide con varias categorías (${labels.join(", ")}). Para no seleccionar evidencia de forma arbitraria, se muestra el informe general completo.`,
      facts: [],
      events: [],
      evidence: [],
    };
  }

  // The two conservative fallbacks above leave exactly one recognized intent.
  const intent = recognition.matchedIntents[0]!;
  if (intent === "timeline") {
    const facts = uniqueById(
      presentation.eventFacts.flatMap((event) => event.observations),
    );
    return {
      originalQuestion: question,
      status: facts.length > 0 ? "resolved" : "unavailable",
      intent,
      matchedIntents: [intent],
      title: "Consulta dirigida: cronología",
      message: facts.length > 0
        ? "Se muestra la secuencia de eventos atestados disponible. Esta vista no atribuye causalidad entre eventos."
        : "La respuesta no contiene eventos atestados suficientes para una vista cronológica dirigida.",
      facts,
      events: presentation.eventFacts,
      evidence: selectedEvidence(presentation, facts),
    };
  }

  if (intent === "evidence") {
    const facts = uniqueById(
      presentation.eventFacts.flatMap((event) => event.observations),
    );
    return {
      originalQuestion: question,
      status: presentation.evidence.length > 0 ? "resolved" : "unavailable",
      intent,
      matchedIntents: [intent],
      title: "Consulta dirigida: evidencias y procedencia",
      message: presentation.evidence.length > 0
        ? "Se muestran las evidencias recuperadas y los hechos atestados que permiten navegar hacia ellas."
        : "La respuesta no contiene evidencias recuperadas para una vista de procedencia dirigida.",
      facts,
      events: presentation.eventFacts,
      evidence: presentation.evidence,
    };
  }

  const ruleIds = new Set(ruleIdsForIntent[intent] ?? []);
  const selectedFacts = uniqueById(
    presentation.patternGroups
      .filter((group) => ruleIds.has(group.ruleId))
      .flatMap((group) =>
        group.instances.flatMap((instance) => instance.matchedFacts),
      ),
  );

  return {
    originalQuestion: question,
    status: selectedFacts.length > 0 ? "resolved" : "unavailable",
    intent,
    matchedIntents: [intent],
    title: `Consulta dirigida: ${intentLabels[intent]}`,
    message: selectedFacts.length > 0
      ? `Se identificaron observaciones relacionadas con ${intentLabels[intent]}. Esta es una vista filtrada de hechos ya atestados, no una conclusión nueva.`
      : `La pregunta se reconoció como ${intentLabels[intent]}, pero la respuesta no contiene hechos atestados suficientes para esa vista. Se muestra el informe general completo.`,
    facts: selectedFacts,
    events: eventsFor(presentation, selectedFacts),
    evidence: selectedEvidence(presentation, selectedFacts),
  };
}
