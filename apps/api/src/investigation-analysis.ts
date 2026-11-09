export type HypothesisStatus =
  | "supported_unconfirmed"
  | "unverified"
  | "contradicted"
  | "insufficient_evidence";

export interface ObservedFact {
  claim: string;
  evidence_refs: string[];
}

export interface InvestigationHypothesis {
  statement: string;
  status: HypothesisStatus;
  supporting_evidence: string[];
  contradicting_evidence: string[];
}

export interface InvestigationAnalysis {
  summary: string;
  summary_evidence_refs: string[];
  observed_facts: ObservedFact[];
  hypotheses: InvestigationHypothesis[];
  missing_information: string[];
  next_checks: string[];
  limitations: string[];
}

export function renderInvestigationAnalysis(
  analysis: InvestigationAnalysis,
): string {
  const formatReferences = (references: string[]) =>
    references.length > 0
      ? ` ${references.map((ref) => `[${ref}]`).join(" ")}`
      : "";
  const section = (heading: string, lines: string[]) =>
    `${heading}:\n${lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- No identificado."}`;
  const hypothesisStatus: Record<HypothesisStatus, string> = {
    supported_unconfirmed: "Respaldada, no confirmada",
    unverified: "No verificada",
    contradicted: "Contradicha",
    insufficient_evidence: "Evidencia insuficiente",
  };
  return [
    `Resumen: ${analysis.summary}${formatReferences(analysis.summary_evidence_refs)}`,
    section(
      "Hechos respaldados por evidencia",
      analysis.observed_facts.map(
        (fact) => `${fact.claim}${formatReferences(fact.evidence_refs)}`,
      ),
    ),
    section(
      "Hipótesis",
      analysis.hypotheses.map(
        (hypothesis) =>
          `${hypothesisStatus[hypothesis.status]}: ${hypothesis.statement}${formatReferences(hypothesis.supporting_evidence)}${hypothesis.contradicting_evidence.length > 0 ? ` (evidencia contradictoria: ${formatReferences(hypothesis.contradicting_evidence).trim()})` : ""}`,
      ),
    ),
    section("Información faltante", analysis.missing_information),
    section("Comprobaciones siguientes", analysis.next_checks),
    section("Limitaciones", analysis.limitations),
  ].join("\n\n");
}
