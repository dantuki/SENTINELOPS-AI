export interface Inc001Evidence {
  id: string;
  content: string;
}

export interface Inc001GroundTruth {
  expected_observations: Array<{ id: string }>;
  must_not_claim: string[];
}

export interface FactualityViolation {
  id: string;
  description: string;
}

export interface Inc001Evaluation {
  retrievalRecall: number;
  answerCoverage: number;
  retrievedObservationIds: string[];
  responseObservationIds: string[];
  citations: {
    count: number;
    invalid: string[];
  };
  factualityViolations: FactualityViolation[];
}

const observationPatterns: Record<string, RegExp> = {
  "OBS-01":
    /req-7841[\s\S]{0,180}\b(?:5|five|cinco)\b[\s\S]{0,100}\b(?:parallel|paralel\w*|concurrent\w*)\b|\b(?:5|five|cinco)\b[\s\S]{0,100}\b(?:parallel|paralel\w*|concurrent\w*)\b[\s\S]{0,180}req-7841/iu,
  "OBS-02":
    /active_connections["'\s:=]+20[\s\S]{0,120}idle_connections["'\s:=]+0[\s\S]{0,120}waiting_requests["'\s:=]+18|20\s+active connections[\s\S]{0,100}0\s+idle connections[\s\S]{0,100}18\s+waiting requests|20\s+conexiones activas[\s\S]{0,100}(?:0|cero)\s+(?:conexiones )?inactivas[\s\S]{0,100}18\s+solicitudes (?:en espera|esperando)|20\/20[\s\S]{0,100}(?:0|cero)\s+conexiones libres[\s\S]{0,100}18\s+solicitudes (?:en espera|esperando|pendientes)|20\/20[\s\S]{0,100}18\s+solicitudes (?:en espera|esperando|pendientes)[\s\S]{0,400}(?:idle_connections["'\s:=]+0|0\s+conexiones libres)|active["'\s:=]+20[\s\S]{0,60}idle["'\s:=]+0[\s\S]{0,60}waiting["'\s:=]+18/iu,
  "OBS-03":
    /(?:status_code["'\s:=]+500|http\s*500|http 500)[\s\S]{0,180}(?:timeout|tiempo de espera)[\s\S]{0,180}(?:req-7841|\/api\/orders)|(?:req-7841|\/api\/orders)[\s\S]{0,180}(?:status_code["'\s:=]+500|http\s*500)[\s\S]{0,180}(?:timeout|tiempo de espera)|(?:req-7841|\/api\/orders)[\s\S]{0,220}(?:timeout|tiempo de espera)[\s\S]{0,180}(?:status_code["'\s:=]+500|http\s*500)|(?:req-7841|\/api\/orders)[\s\S]{0,220}(?:timeout|tiempo de espera)[\s\S]{0,220}(?:status_code["'\s:=]+500|http\s*500|http 500)/iu,
  "OBS-04":
    /(?:queue_depth["'\s:=]+42|cola[^.!?]{0,80}42)[\s\S]{0,120}(?:retries_started_last_minute["'\s:=]+120|120 reintentos|120 retries)|(?:120 reintentos|120 retries)[\s\S]{0,120}(?:queue_depth["'\s:=]+42|cola[^.!?]{0,80}42)/iu,
  "OBS-05":
    /waiting_requests["'\s:=]+31[\s\S]{0,160}active_connections["'\s:=]+20|active_connections["'\s:=]+20[\s\S]{0,160}waiting_requests["'\s:=]+31|31\s+solicitudes (?:en espera|esperando)[\s\S]{0,100}20\s+conexiones activas|20\s+conexiones activas[\s\S]{0,100}31\s+solicitudes (?:en espera|esperando)|(?:saturaci[oó]n|pool)[\s\S]{0,80}persisti[oó][\s\S]{0,180}31\s+solicitudes (?:en espera|esperando|pendientes)|pool[\s\S]{0,80}permaneci[oó]\s+saturado[\s\S]{0,180}31\s+solicitudes (?:en espera|esperando|pendientes)/iu,
  "OBS-06":
    /payment-gateway[\s\S]{0,120}(?:status_code["'\s:=]+200|http\s*200)[\s\S]{0,80}(?:duration_ms["'\s:=]+180|180\s*ms|180 milisegundos)|(?:status_code["'\s:=]+200|http\s*200)[\s\S]{0,120}payment-gateway[\s\S]{0,80}(?:duration_ms["'\s:=]+180|180\s*ms|180 milisegundos)/iu,
};

const factualityRules: Array<{
  id: string;
  description: string;
  pattern: RegExp;
}> = [
  {
    id: "waiting-requests-as-blocked-transactions",
    description:
      "Interpreta waiting_requests como transacciones bloqueadas.",
    pattern:
      /\b(?:18|31)\s+(?:blocked\s+transactions?|transactions?\s+(?:are\s+)?blocked)\b|\b(?:18|31)\s+transacciones?\s+bloqueadas?\b/iu,
  },
  {
    id: "active-connections-as-available",
    description:
      "Interpreta las conexiones activas como conexiones disponibles.",
    pattern:
      /\bactive_connections["'\s:=]+20\s+(?:are\s+)?(?:available|free)\b|\b20\s+active connections\s+(?:are\s+)?(?:available|free)\b|\b20\s+conexiones activas\s+(?:están\s+)?(?:disponibles|libres)\b/iu,
  },
  {
    id: "idle-connections-as-occupied",
    description:
      "Interpreta las conexiones inactivas como conexiones ocupadas.",
    pattern:
      /\bidle_connections["'\s:=]+0\s+(?:are\s+)?(?:occupied|busy|in use)\b|\b0\s+idle connections\s+(?:are\s+)?(?:occupied|busy|in use)\b|\b0\s+conexiones inactivas\s+(?:están\s+)?(?:ocupadas|en uso)\b/iu,
  },
  {
    id: "component-http-200-as-business-success",
    description:
      "Interpreta el HTTP 200 de payment-gateway como éxito de create_order.",
    pattern:
      /payment-gateway[\s\S]{0,100}(?:http\s*200|status_code["'\s:=]+200)[\s\S]{0,100}(?:demuestra|confirma|garantiza|means|proves)[\s\S]{0,80}(?:create_order|operaci[oó]n de negocio|pedido)[\s\S]{0,60}(?:complet|exitos|successful|succeeded)|(?:create_order|operaci[oó]n de negocio|pedido)[\s\S]{0,80}(?:complet|exitos|successful|succeeded)[\s\S]{0,100}payment-gateway[\s\S]{0,100}(?:http\s*200|status_code["'\s:=]+200)|payment-gateway[\s\S]{0,100}(?:demuestra|confirma|garantiza|means|proves)[\s\S]{0,100}(?:create_order|operaci[oó]n de negocio|pedido)[\s\S]{0,60}(?:complet|exitos|successful|succeeded)/iu,
  },
  {
    id: "unsupported-http-500-business-outcome",
    description:
      "Atribuye el HTTP 500 a payment-gateway o lo presenta como resultado total del negocio.",
    pattern:
      /payment-gateway[\s\S]{0,120}(?:caus[oó]|provoc[oó]|origin[oó]|caused|triggered)[\s\S]{0,100}(?:http\s*500|status_code["'\s:=]+500)|(?:http\s*500|status_code["'\s:=]+500)[\s\S]{0,100}(?:demuestra|confirma|indica|significa|means|proves)[\s\S]{0,100}(?:falla total|fallo total|fracaso total|operaci[oó]n completa|resultado del negocio|complete business failure)/iu,
  },
  {
    id: "unproven-pool-root-cause",
    description:
      "Presenta la saturación del pool como causa definitiva del error HTTP 500.",
    pattern:
      /(?:saturaci[oó]n (?:del|de) (?:pool|conexiones)|pool de conexiones)[\s\S]{0,100}(?:caus[oó]|provoc[oó]|origin[oó]|caused|triggered)[\s\S]{0,120}(?:http\s*500|falla|fallo|error)/iu,
  },
  {
    id: "similarity-as-causal-probability",
    description:
      "Interpreta la similitud de recuperación como probabilidad causal.",
    pattern:
      /(?:similarity|similitud)[\s\S]{0,100}(?:causal probability|probabilidad causal|probabilidad de causa raíz|demuestra la causa raíz|proves the root cause)/iu,
  },
  {
    id: "synthetic-code-as-production-execution",
    description:
      "Afirma que el código sintético se ejecutó o desplegó en producción.",
    pattern:
      /(?:synthetic|sint[eé]tic)[\s\S]{0,100}(?:was executed|was deployed|se ejecut[oó]|se despleg[oó]|fue ejecutado|fue desplegado)[\s\S]{0,80}(?:production|producci[oó]n)|(?:production|producci[oó]n)[\s\S]{0,80}(?:synthetic|sint[eé]tic)[\s\S]{0,100}(?:was executed|was deployed|se ejecut[oó]|se despleg[oó]|fue ejecutado|fue desplegado)/iu,
  },
  {
    id: "temporal-coincidence-as-proven-causality",
    description:
      "Presenta una coincidencia temporal como causalidad demostrada.",
    pattern:
      /(?:temporal coincidence|coincidencia temporal|secuencia temporal)[\s\S]{0,100}(?:demuestra|prueba|confirma|proves|demonstrates)[\s\S]{0,80}(?:causalidad|causality|causa ra[ií]z|root cause)/iu,
  },
];

function isExplicitlyNegated(
  text: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const start = Math.max(
    text.lastIndexOf(".", matchIndex),
    text.lastIndexOf(";", matchIndex),
    text.lastIndexOf("\n", matchIndex),
    text.lastIndexOf("!", matchIndex),
    text.lastIndexOf("?", matchIndex),
  ) + 1;
  const following = text.slice(matchIndex + matchLength);
  const sentenceEnd = following.search(/[.!?;\n]/u);
  const end =
    sentenceEnd === -1
      ? text.length
      : matchIndex + matchLength + sentenceEnd;
  const sentence = text.slice(start, end);

  return /\bno\b[^.!?]{0,120}\b(?:hay|es|son|demuestra|prueba|confirma|significa|representa|puede|fue|ejecut\w*|despleg\w*)\b|\b(?:not|never|doesn't|does not)\b[^.!?]{0,120}\b(?:available|executed|deployed|prove|demonstrate|mean)\b/iu.test(
    sentence,
  );
}

function matchesUnnegatedClaim(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);

  return (
    match !== null &&
    !isExplicitlyNegated(text, match.index, match[0].length)
  );
}

export function evaluateInc001Response(
  response: string,
  evidence: Inc001Evidence[],
  groundTruth: Inc001GroundTruth,
): Inc001Evaluation {
  const expectedIds = groundTruth.expected_observations.map(
    (observation) => observation.id,
  );
  const retrievedObservationIds = expectedIds.filter((id) => {
    const pattern = observationPatterns[id];
    return (
      pattern !== undefined &&
      evidence.some((item) => pattern.test(item.content))
    );
  });
  const responseObservationIds = expectedIds.filter((id) => {
    const pattern = observationPatterns[id];
    return pattern !== undefined && pattern.test(response);
  });
  const citations = [...response.matchAll(/\[E(\d+)\]/giu)].map(
    (match) => Number(match[1]),
  );
  const invalid = [
    ...new Set(
      citations
        .filter((index) => index < 1 || index > evidence.length)
        .map((index) => `[E${index}]`),
    ),
  ];

  return {
    retrievalRecall:
      expectedIds.length === 0
        ? 0
        : retrievedObservationIds.length / expectedIds.length,
    answerCoverage:
      expectedIds.length === 0
        ? 0
        : responseObservationIds.length / expectedIds.length,
    retrievedObservationIds,
    responseObservationIds,
    citations: {
      count: citations.length,
      invalid,
    },
    factualityViolations: factualityRules
      .filter((rule) => matchesUnnegatedClaim(response, rule.pattern))
      .map(({ id, description }) => ({ id, description })),
  };
}
