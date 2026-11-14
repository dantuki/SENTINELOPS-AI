"use client";

import { ProductApiStatus } from "@/components/product-api-status";
import { messageForInvestigationStatus } from "@/lib/investigation-error";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

interface Workspace {
  id: string;
  name: string;
  status: "active" | "archived";
}

interface Project {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  status: "active" | "archived";
}

interface Incident {
  id: string;
  projectId: string;
  externalReference: string | null;
  title: string;
  description: string | null;
  serviceName: string | null;
  severity:
    | "critical"
    | "high"
    | "medium"
    | "low"
    | "informational"
    | "unknown";
  status:
    | "new"
    | "triaged"
    | "investigating"
    | "resolved"
    | "closed";
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface Evidence {
  evidenceId: string;
  alias: string;
  documentId: string;
  ordinal: number;
  rank: number;
  content: string;
  score: number;
}

type HypothesisStatus =
  | "supported_unconfirmed"
  | "unverified"
  | "contradicted"
  | "insufficient_evidence";

interface InvestigationAnalysis {
  summary: string;
  summary_evidence_refs: string[];
  observed_facts: Array<{
    claim: string;
    evidence_refs: string[];
  }>;
  hypotheses: Array<{
    statement: string;
    status: HypothesisStatus;
    supporting_evidence: string[];
    contradicting_evidence: string[];
  }>;
  missing_information: string[];
  next_checks: string[];
  limitations: string[];
}

interface InvestigationResult {
  model: string;
  response: string;
  evidence: Evidence[];
  analysis: InvestigationAnalysis;
  verifiedInvestigationResult?: VerifiedInvestigationResult;
  deterministicInvestigationResult?: DeterministicInvestigationResult;
}

interface DeterministicInvestigationResult {
  schemaVersion: "investigation-result-v2";
  mode: "deterministic" | "hybrid" | "ai";
  status: "complete" | "partial" | "insufficient_evidence";
  verifiedObservations: Array<{ evidenceAlias: string; eventId: string; property: string; value: string | number | boolean | null; unit: string | null }>;
  detectedPatterns: Array<{ ruleId: string; description: string; evidenceRefs: string[] }>;
  hypotheses: Array<{ statement: string; status: "insufficient_evidence"; missingEvidence: string[] }>;
  limitations: string[];
  recommendedChecks: string[];
  aiEnrichment: { status: "not_requested" | "unavailable" | "invalid" | "validated"; model: string | null; failure: string | null };
  gateResult: { gate: "evidence-first-deterministic-product-gate-v2"; status: "pass" | "fail"; reasons: string[] };
}

interface VerifiedInvestigationResult {
  version: "verified-investigation-result-v1";
  verifiedObservations: Array<{
    evidenceAlias: string;
    eventId: string;
    property: string;
    value: string | number | boolean | null;
    unit: string | null;
    verificationStatus: "verified";
  }>;
  aiAnalysis: {
    status: "validated" | "not_invoked" | "invalid";
    failure: string;
  };
}

interface TimelineEvent {
  timestamp: string;
  service: string;
  level: string | null;
  event: string | null;
  message: string | null;
  evidenceId: string;
  evidenceNumber: number;
}

class ApiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const suggestedQuestions = [
  "¿Qué hechos están respaldados por la evidencia y qué sigue siendo una hipótesis?",
  "¿Qué secuencia temporal muestran los logs recuperados?",
  "¿Qué información falta para confirmar la causa del incidente?",
];

const severityLabels: Record<Incident["severity"], string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Media",
  low: "Baja",
  informational: "Informativa",
  unknown: "Sin clasificar",
};

const statusLabels: Record<Incident["status"], string> = {
  new: "Nuevo",
  triaged: "En triage",
  investigating: "En investigación",
  resolved: "Resuelto",
  closed: "Cerrado",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.status === "active" || value.status === "archived")
  );
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.name === "string" &&
    typeof value.slug === "string" &&
    (typeof value.description === "string" ||
      value.description === null) &&
    (value.status === "active" || value.status === "archived")
  );
}

function isIncident(value: unknown): value is Incident {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    (typeof value.externalReference === "string" ||
      value.externalReference === null) &&
    typeof value.title === "string" &&
    (typeof value.description === "string" ||
      value.description === null) &&
    (typeof value.serviceName === "string" ||
      value.serviceName === null) &&
    [
      "critical",
      "high",
      "medium",
      "low",
      "informational",
      "unknown",
    ].includes(String(value.severity)) &&
    ["new", "triaged", "investigating", "resolved", "closed"].includes(
      String(value.status),
    ) &&
    isRecord(value.context) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isEvidence(value: unknown): value is Evidence {
  return (
    isRecord(value) &&
    typeof value.evidenceId === "string" &&
    typeof value.alias === "string" &&
    typeof value.documentId === "string" &&
    Number.isInteger(value.ordinal) &&
    Number.isInteger(value.rank) &&
    typeof value.content === "string" &&
    typeof value.score === "number" &&
    Number.isFinite(value.score)
  );
}

function isEvidenceReferences(
  value: unknown,
  evidenceCount: number,
  allowEmpty: boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (reference) =>
        typeof reference === "string" &&
        /^E[1-9]\d*$/u.test(reference) &&
        Number(reference.slice(1)) <= evidenceCount,
    )
  );
}

function isInvestigationAnalysis(
  value: unknown,
  evidenceCount: number,
): value is InvestigationAnalysis {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0 &&
    isEvidenceReferences(value.summary_evidence_refs, evidenceCount, evidenceCount === 0) &&
    Array.isArray(value.observed_facts) &&
    value.observed_facts.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.claim === "string" &&
        fact.claim.trim().length > 0 &&
        isEvidenceReferences(fact.evidence_refs, evidenceCount, false),
    ) &&
    Array.isArray(value.hypotheses) &&
    value.hypotheses.every(
      (hypothesis) =>
        isRecord(hypothesis) &&
        typeof hypothesis.statement === "string" &&
        hypothesis.statement.trim().length > 0 &&
        [
          "supported_unconfirmed",
          "unverified",
          "contradicted",
          "insufficient_evidence",
        ].includes(String(hypothesis.status)) &&
        isEvidenceReferences(
          hypothesis.supporting_evidence,
          evidenceCount,
          true,
        ) &&
        isEvidenceReferences(
          hypothesis.contradicting_evidence,
          evidenceCount,
          true,
        ),
    ) &&
    ["missing_information", "next_checks", "limitations"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].every(
          (item) => typeof item === "string" && item.trim().length > 0,
        ),
    )
  );
}

function isVerifiedInvestigationResult(value: unknown): value is VerifiedInvestigationResult {
  return isRecord(value) && value.version === "verified-investigation-result-v1" &&
    Array.isArray(value.verifiedObservations) &&
    value.verifiedObservations.every((observation) =>
      isRecord(observation) && typeof observation.evidenceAlias === "string" &&
      typeof observation.eventId === "string" && typeof observation.property === "string" &&
      (["string", "number", "boolean"].includes(typeof observation.value) || observation.value === null),
    ) && isRecord(value.aiAnalysis) &&
    ["validated", "not_invoked", "invalid"].includes(String(value.aiAnalysis.status)) &&
    typeof value.aiAnalysis.failure === "string";
}

function isDeterministicInvestigationResult(value: unknown): value is DeterministicInvestigationResult {
  return isRecord(value) && value.schemaVersion === "investigation-result-v2" &&
    ["deterministic", "hybrid", "ai"].includes(String(value.mode)) &&
    ["complete", "partial", "insufficient_evidence"].includes(String(value.status)) &&
    Array.isArray(value.verifiedObservations) && Array.isArray(value.detectedPatterns) &&
    Array.isArray(value.hypotheses) && Array.isArray(value.limitations) &&
    Array.isArray(value.recommendedChecks) && isRecord(value.aiEnrichment) &&
    ["not_requested", "unavailable", "invalid", "validated"].includes(String(value.aiEnrichment.status)) &&
    isRecord(value.gateResult) && value.gateResult.gate === "evidence-first-deterministic-product-gate-v2" &&
    ["pass", "fail"].includes(String(value.gateResult.status));
}

function isInvestigationResult(
  value: unknown,
): value is InvestigationResult {
  return (
    isRecord(value) &&
    typeof value.model === "string" &&
    typeof value.response === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidence) &&
    isInvestigationAnalysis(value.analysis, value.evidence.length) &&
    (value.verifiedInvestigationResult === undefined || isVerifiedInvestigationResult(value.verifiedInvestigationResult)) &&
    (value.deterministicInvestigationResult === undefined || isDeterministicInvestigationResult(value.deterministicInvestigationResult))
  );
}

function isListPayload<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is { data: T[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.data) &&
    value.data.every(isItem)
  );
}

async function requestList<T>(
  url: string,
  signal: AbortSignal,
  isItem: (item: unknown) => item is T,
): Promise<T[]> {
  const response = await fetch(url, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new ApiRequestError(messageForInvestigationStatus(response.status));
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError("El servicio devolvió una respuesta no válida.");
  }

  if (!isListPayload(payload, isItem)) {
    throw new ApiRequestError("El servicio devolvió datos incompletos.");
  }

  return payload.data;
}

function getErrorMessage(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : "No se pudo conectar con el servicio. Comprueba su estado e inténtalo de nuevo.";
}

function getProjectOrder(projects: Project[]): Project[] {
  return [...projects].sort((first, second) => {
    if (first.status !== second.status) {
      return first.status === "active" ? -1 : 1;
    }

    return first.name.localeCompare(second.name);
  });
}

function getIncidentOrder(incidents: Incident[]): Incident[] {
  return [...incidents].sort((first, second) => {
    const priority = (incident: Incident) =>
      incident.status === "investigating"
        ? 0
        : incident.status === "new"
          ? 1
          : 2;

    return (
      priority(first) - priority(second) ||
      second.updatedAt.localeCompare(first.updatedAt)
    );
  });
}

function parseTimeline(evidence: Evidence[]): TimelineEvent[] {
  return evidence
    .flatMap((item, index) =>
      item.content.split(/\r?\n/u).flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);

          if (
            !isRecord(value) ||
            typeof value.timestamp !== "string" ||
            !Number.isFinite(Date.parse(value.timestamp)) ||
            typeof value.service !== "string"
          ) {
            return [];
          }

          return [
            {
              timestamp: value.timestamp,
              service: value.service,
              level:
                typeof value.level === "string" ? value.level : null,
              event:
                typeof value.event === "string" ? value.event : null,
              message:
                typeof value.message === "string"
                  ? value.message
                  : null,
              evidenceId: item.evidenceId,
              evidenceNumber: index + 1,
            },
          ];
        } catch {
          return [];
        }
      }),
    )
    .sort((first, second) =>
      first.timestamp.localeCompare(second.timestamp),
    );
}

function isSyntheticEvidence(evidence: Evidence[]): boolean {
  return evidence.some(
    (item) =>
      item.content.includes("sentinelops-synthetic-demo-v1") ||
      /SENTINELOPS AI - SINT[EÉ]TICO PARA DEMOSTRACI[ÓO]N/iu.test(
        item.content,
      ),
  );
}

function splitResponseSections(
  response: string,
): Array<{ title: string | null; content: string }> {
  const sectionPattern =
    /^\s*(?:\d+[.)]\s*)?(Hechos respaldados por evidencia|Hipótesis pendientes de confirmar|Información faltante|Próximas comprobaciones recomendadas|Limitaciones)\s*:?\s*$/iu;
  const sections: Array<{ title: string | null; content: string }> = [];
  let current: { title: string | null; content: string } | undefined;

  for (const line of response.split(/\r?\n/u)) {
    const summary = /^\s*Resumen:\s*(.*)$/iu.exec(line);
    if (summary) {
      if (current) {
        sections.push(current);
      }

      current = { title: "Resumen", content: summary[1] };
      continue;
    }

    const heading = sectionPattern.exec(line);

    if (heading) {
      if (current) {
        sections.push(current);
      }

      current = { title: heading[1], content: "" };
      continue;
    }

    if (!current) {
      current = { title: null, content: "" };
    }

    current.content += `${current.content.length > 0 ? "\n" : ""}${line}`;
  }

  if (current) {
    sections.push(current);
  }

  if (sections.length > 1 && sections[0].title === null) {
    sections.shift();
  }

  return sections;
}

function renderCitations(
  text: string,
  evidence: Evidence[],
  onSelect: (evidenceId: string) => void,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const citationPattern = /\[E(\d+)\]/gu;
  let previousIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = citationPattern.exec(text)) !== null) {
    parts.push(text.slice(previousIndex, match.index));
    const evidenceIndex = Number(match[1]) - 1;
    const citedEvidence = evidence[evidenceIndex];

    if (citedEvidence) {
      parts.push(
        <button
          className="citation-link"
          key={`${match.index}-${match[1]}`}
          onClick={() => onSelect(citedEvidence.evidenceId)}
          type="button"
          aria-label={`Consultar evidencia E${match[1]}`}
        >
          [E{match[1]}]
        </button>,
      );
    } else {
      parts.push(match[0]);
    }

    previousIndex = match.index + match[0].length;
  }

  parts.push(text.slice(previousIndex));
  return parts;
}

export function InvestigationWorkspace() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState("");
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [incidentsLoading, setIncidentsLoading] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [selectionRetry, setSelectionRetry] = useState(0);
  const [question, setQuestion] = useState("");
  const [investigationMode, setInvestigationMode] = useState<"deterministic" | "hybrid" | "ai">("hybrid");
  const [lastQuestion, setLastQuestion] = useState("");
  const [result, setResult] = useState<InvestigationResult | null>(null);
  const [investigationError, setInvestigationError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedEvidenceId, setExpandedEvidenceId] = useState("");
  const submissionInProgress = useRef(false);
  const investigationRequestSequence = useRef(0);
  const activeInvestigationController = useRef<AbortController | null>(null);

  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );
  const selectedIncident = incidents.find(
    (incident) => incident.id === selectedIncidentId,
  );
  const timeline = result ? parseTimeline(result.evidence) : [];
  const syntheticEvidence = result
    ? isSyntheticEvidence(result.evidence)
    : false;

  useEffect(
    () => () => {
      investigationRequestSequence.current += 1;
      activeInvestigationController.current?.abort();
      activeInvestigationController.current = null;
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadWorkspaces() {
      setWorkspacesLoading(true);
      setSelectionError("");

      try {
        const items = await requestList(
          "/api/workspaces",
          controller.signal,
          isWorkspace,
        );
        setWorkspaces(items);
        setSelectedWorkspaceId(
          (current) =>
            (items.some((item) => item.id === current) && current) ||
            items.find((item) => item.status === "active")?.id ||
            items[0]?.id ||
            "",
        );
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setSelectionError(getErrorMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) {
          setWorkspacesLoading(false);
        }
      }
    }

    void loadWorkspaces();
    return () => controller.abort();
  }, [selectionRetry]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setProjects([]);
      setSelectedProjectId("");
      return;
    }

    const controller = new AbortController();

    async function loadProjects() {
      setProjectsLoading(true);
      setSelectionError("");
      setProjects([]);
      setSelectedProjectId("");

      try {
        const items = await requestList(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/projects`,
          controller.signal,
          isProject,
        );
        const orderedItems = getProjectOrder(items);
        setProjects(orderedItems);
        setSelectedProjectId(
          (current) =>
            (orderedItems.some((item) => item.id === current) && current) ||
            orderedItems[0]?.id ||
            "",
        );
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setSelectionError(getErrorMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) {
          setProjectsLoading(false);
        }
      }
    }

    void loadProjects();
    return () => controller.abort();
  }, [selectedWorkspaceId, selectionRetry]);

  useEffect(() => {
    if (!selectedProjectId) {
      setIncidents([]);
      setSelectedIncidentId("");
      return;
    }

    const controller = new AbortController();

    async function loadIncidents() {
      setIncidentsLoading(true);
      setSelectionError("");
      setIncidents([]);
      setSelectedIncidentId("");

      try {
        const items = await requestList(
          `/api/projects/${encodeURIComponent(selectedProjectId)}/incidents`,
          controller.signal,
          isIncident,
        );
        const orderedItems = getIncidentOrder(items);
        setIncidents(orderedItems);
        setSelectedIncidentId(
          (current) =>
            (orderedItems.some((item) => item.id === current) && current) ||
            orderedItems[0]?.id ||
            "",
        );
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setSelectionError(getErrorMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIncidentsLoading(false);
        }
      }
    }

    void loadIncidents();
    return () => controller.abort();
  }, [selectedProjectId, selectionRetry]);

  function resetInvestigation() {
    investigationRequestSequence.current += 1;
    activeInvestigationController.current?.abort();
    activeInvestigationController.current = null;
    submissionInProgress.current = false;
    setIsSubmitting(false);
    setResult(null);
    setLastQuestion("");
    setInvestigationError("");
    setExpandedEvidenceId("");
  }

  async function runInvestigation(
    submittedQuestion: string,
  ): Promise<void> {
    if (
      submissionInProgress.current ||
      !selectedProject ||
      !selectedIncident ||
      submittedQuestion.trim().length === 0
    ) {
      return;
    }

    const requestId = investigationRequestSequence.current + 1;
    investigationRequestSequence.current = requestId;
    const controller = new AbortController();
    activeInvestigationController.current = controller;
    submissionInProgress.current = true;
    setIsSubmitting(true);
    setInvestigationError("");
    setLastQuestion(submittedQuestion.trim());

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/investigate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({
            question: submittedQuestion.trim(),
            limit: 10,
            incidentId:
              selectedIncident.externalReference?.trim() ||
              selectedIncident.id,
            mode: investigationMode,
          }),
        },
      );

      if (!response.ok) {
        throw new ApiRequestError(messageForInvestigationStatus(response.status));
      }

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        throw new ApiRequestError(
          "El servicio devolvió una respuesta no válida.",
        );
      }

      if (
        !isRecord(payload) ||
        !isInvestigationResult(payload.data)
      ) {
        throw new ApiRequestError(
          "El servicio devolvió datos incompletos.",
        );
      }

      if (investigationRequestSequence.current === requestId) {
        setResult(payload.data);
        setQuestion("");
        setExpandedEvidenceId("");
      }
    } catch (error: unknown) {
      if (
        investigationRequestSequence.current === requestId &&
        !controller.signal.aborted
      ) {
        setInvestigationError(getErrorMessage(error));
      }
    } finally {
      if (activeInvestigationController.current === controller) {
        activeInvestigationController.current = null;
        submissionInProgress.current = false;
        setIsSubmitting(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runInvestigation(question);
  }

  function handleProjectChange(projectId: string) {
    setSelectedProjectId(projectId);
    resetInvestigation();
  }

  function handleIncidentChange(incidentId: string) {
    setSelectedIncidentId(incidentId);
    resetInvestigation();
  }

  function focusEvidence(evidenceId: string) {
    setExpandedEvidenceId(evidenceId);
    window.setTimeout(() => {
      document
        .getElementById(`evidence-${evidenceId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 0);
  }

  return (
    <main className="investigation-app">
      <header className="investigation-topbar">
        <a
          className="workspace-brand"
          href="/"
          aria-label="SentinelOps AI, volver al inicio"
        >
          <span className="workspace-brand-mark" aria-hidden="true">
            S
          </span>
          <span>
            <strong>SENTINELOPS</strong>
            <small>AI INCIDENT INTELLIGENCE</small>
          </span>
        </a>

        <div className="workspace-breadcrumb">
          <a href="/">Inicio</a>
          <span aria-hidden="true">/</span>
          <span>Investigation Workspace</span>
        </div>

        <div className="workspace-topbar-actions">
          <div className="workspace-topbar-status">
            <ProductApiStatus />
          </div>
          <a className="workspace-home-link" href="/">
            Volver al producto
          </a>
        </div>
      </header>

      <div className="workspace-shell">
        <aside className="workspace-sidebar" aria-label="Navegación">
          <p className="sidebar-label">PRODUCTO</p>
          <a className="sidebar-item" href="/">
            <span className="sidebar-icon" aria-hidden="true">OV</span>
            Overview
          </a>
          <a
            className="sidebar-item sidebar-item--active"
            href="/investigation"
            aria-current="page"
          >
            <span className="sidebar-icon" aria-hidden="true">IN</span>
            Investigation
          </a>
          <a className="sidebar-item" href="/knowledge-base">
            <span className="sidebar-icon" aria-hidden="true">KB</span>
            Knowledge Base
          </a>
          <div className="sidebar-divider" />
          <p className="sidebar-label">CONTEXTO ACTUAL</p>
          <div className="sidebar-context">
            <span className="context-indicator" aria-hidden="true" />
            <div>
              <span>Espacio de trabajo</span>
              <strong>{selectedWorkspace?.name ?? "Sin seleccionar"}</strong>
            </div>
          </div>
          <div className="sidebar-footnote">
            Investigaciones basadas en fuentes recuperadas del proyecto.
          </div>
        </aside>

        <section className="workspace-content">
          <div className="workspace-heading">
            <div>
              <p className="workspace-eyebrow">INVESTIGACIÓN DE INCIDENTES</p>
              <h1>Investigation Workspace</h1>
              <p className="workspace-subtitle">
                Explora señales, contrasta hipótesis y consulta la evidencia
                que respalda cada respuesta.
              </p>
            </div>
            <div className="workspace-readonly">
              <span className="readonly-dot" aria-hidden="true" />
              Solo lectura
            </div>
          </div>

          <section className="selection-panel" aria-label="Contexto de investigación">
            <div className="selector-field">
              <label htmlFor="workspace-select">Workspace</label>
              <select
                id="workspace-select"
                value={selectedWorkspaceId}
                onChange={(event) => {
                  setSelectedWorkspaceId(event.target.value);
                  resetInvestigation();
                }}
                disabled={workspacesLoading || workspaces.length === 0}
              >
                <option value="">
                  {workspacesLoading
                    ? "Cargando workspaces..."
                    : "Selecciona un workspace"}
                </option>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.name}
                    {workspace.status === "archived" ? " · archivado" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="selector-field">
              <label htmlFor="project-select">Proyecto</label>
              <select
                id="project-select"
                value={selectedProjectId}
                onChange={(event) =>
                  handleProjectChange(event.target.value)
                }
                disabled={
                  projectsLoading ||
                  !selectedWorkspaceId ||
                  projects.length === 0
                }
              >
                <option value="">
                  {projectsLoading
                    ? "Cargando proyectos..."
                    : "Selecciona un proyecto"}
                </option>
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                    {project.status === "archived" ? " · archivado" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="selector-field selector-field--incident">
              <label htmlFor="incident-select">Incidente</label>
              <select
                id="incident-select"
                value={selectedIncidentId}
                onChange={(event) =>
                  handleIncidentChange(event.target.value)
                }
                disabled={
                  incidentsLoading ||
                  !selectedProjectId ||
                  incidents.length === 0
                }
              >
                <option value="">
                  {incidentsLoading
                    ? "Cargando incidentes..."
                    : incidents.length === 0
                      ? "No hay incidentes disponibles"
                      : "Selecciona un incidente"}
                </option>
                {incidents.map((incident) => (
                  <option value={incident.id} key={incident.id}>
                    {incident.externalReference
                      ? `${incident.externalReference} · `
                      : ""}
                    {incident.title}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {selectionError ? (
            <div className="inline-error" role="alert">
              <span>{selectionError}</span>
              <button
                type="button"
                onClick={() => {
                  setSelectionError("");
                  setSelectionRetry((current) => current + 1);
                }}
              >
                Reintentar
              </button>
            </div>
          ) : null}

          {!workspacesLoading && workspaces.length === 0 && !selectionError ? (
            <div className="selection-empty">
              No hay workspaces disponibles en la API de producto.
            </div>
          ) : null}

          <div className="investigation-grid">
            <section className="investigation-main">
              {selectedIncident ? (
                <article className="incident-card">
                  <div className="incident-card-top">
                    <div className="incident-title-group">
                      <p className="incident-reference">
                        {selectedIncident.externalReference?.trim() ||
                          selectedIncident.id}
                      </p>
                      <h2>{selectedIncident.title}</h2>
                    </div>
                    <span
                      className={`severity-badge severity-badge--${selectedIncident.severity}`}
                    >
                      {severityLabels[selectedIncident.severity]}
                    </span>
                  </div>

                  <div className="incident-metadata">
                    <span>
                      <small>ESTADO</small>
                      {statusLabels[selectedIncident.status]}
                    </span>
                    <span>
                      <small>SERVICIO</small>
                      {selectedIncident.serviceName ?? "No especificado"}
                    </span>
                    <span>
                      <small>PROYECTO</small>
                      {selectedProject?.name ?? "No especificado"}
                    </span>
                  </div>

                  {selectedIncident.description ? (
                    <p className="incident-description">
                      {selectedIncident.description}
                    </p>
                  ) : (
                    <p className="incident-description incident-description--muted">
                      El registro del incidente no incluye una descripción
                      adicional.
                    </p>
                  )}
                  {Object.keys(selectedIncident.context).length > 0 ? (
                    <details className="incident-context">
                      <summary>Consultar contexto registrado</summary>
                      <pre>
                        {JSON.stringify(selectedIncident.context, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </article>
              ) : (
                <div className="incident-card incident-placeholder">
                  <span className="placeholder-mark" aria-hidden="true">
                    IN
                  </span>
                  <div>
                    <h2>
                      {incidentsLoading
                        ? "Cargando contexto del incidente"
                        : "Selecciona un incidente para comenzar"}
                    </h2>
                    <p>
                      El contexto y las evidencias aparecerán aquí cuando
                      selecciones un incidente real del proyecto.
                    </p>
                  </div>
                </div>
              )}

              <section className="timeline-panel" aria-labelledby="timeline-title">
                <div className="panel-heading">
                  <div>
                    <p className="panel-kicker">SECUENCIA OBSERVADA</p>
                    <h2 id="timeline-title">Cronología</h2>
                  </div>
                  {timeline.length > 0 ? (
                    <span className="timeline-count">
                      {timeline.length} eventos
                    </span>
                  ) : null}
                </div>

                {timeline.length > 0 ? (
                  <ol className="timeline-list">
                    {timeline.map((item, index) => (
                      <li
                        className="timeline-event"
                        key={`${item.evidenceId}-${item.timestamp}-${index}`}
                      >
                        <span
                          className="timeline-marker"
                          aria-hidden="true"
                        />
                        <time dateTime={item.timestamp}>
                          {item.timestamp}
                        </time>
                        <div className="timeline-event-content">
                          <div className="timeline-event-heading">
                            <strong>{item.service}</strong>
                            {item.level ? (
                              <span
                                className={`event-level event-level--${item.level.toLowerCase()}`}
                              >
                                {item.level}
                              </span>
                            ) : null}
                          </div>
                          {item.event ? (
                            <p className="timeline-event-name">
                              {item.event}
                            </p>
                          ) : null}
                          {item.message ? (
                            <p className="timeline-event-message">
                              {item.message}
                            </p>
                          ) : null}
                          <button
                            type="button"
                            className="timeline-source"
                            onClick={() => focusEvidence(item.evidenceId)}
                          >
                            Consultar [E{item.evidenceNumber}]
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="timeline-empty">
                    <span className="timeline-empty-icon" aria-hidden="true">
                      —
                    </span>
                    <p>
                      {result
                        ? "Las evidencias recuperadas no contienen logs estructurados con timestamps válidos."
                        : "La cronología se construirá a partir de los logs estructurados recuperados en la investigación."}
                    </p>
                  </div>
                )}
              </section>

              <section className="investigation-panel" aria-labelledby="investigation-title">
                <div className="panel-heading">
                  <div>
                    <p className="panel-kicker">CONSULTA BASADA EN EVIDENCIA</p>
                    <h2 id="investigation-title">Investigar incidente</h2>
                  </div>
                  {result ? (
                    <button
                      className="new-investigation-button"
                      type="button"
                      onClick={resetInvestigation}
                    >
                      Nueva consulta
                    </button>
                  ) : null}
                </div>

                {selectedIncident ? (
                  <>
                    {!result ? (
                      <div className="suggested-questions">
                        <p>Para empezar</p>
                        <div>
                          {suggestedQuestions.map((suggestion) => (
                            <button
                              className="suggestion-chip"
                              key={suggestion}
                              onClick={() => setQuestion(suggestion)}
                              type="button"
                              disabled={isSubmitting}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <form
                      className="investigation-composer"
                      onSubmit={handleSubmit}
                    >
                      <label htmlFor="investigation-question">
                        Pregunta de investigación
                      </label>
                      <textarea
                        id="investigation-question"
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                        maxLength={20_000}
                        placeholder="Pregunta por los síntomas, la cronología o la evidencia que falta..."
                        rows={4}
                        disabled={isSubmitting}
                      />
                      <label htmlFor="investigation-mode">
                        Modo de investigación
                      </label>
                      <select
                        id="investigation-mode"
                        value={investigationMode}
                        onChange={(event) => setInvestigationMode(event.target.value as "deterministic" | "hybrid" | "ai")}
                        disabled={isSubmitting}
                      >
                        <option value="hybrid">Híbrido: evidencia primero, enriquecimiento IA opcional</option>
                        <option value="deterministic">Determinista: sin generación de chat</option>
                        <option value="ai">Solo IA: requiere análisis generativo válido</option>
                      </select>
                      <div className="composer-footer">
                        <span>
                          La respuesta se limitará a las evidencias
                          recuperadas.
                        </span>
                        <button
                          className="investigate-button"
                          type="submit"
                          disabled={
                            isSubmitting ||
                            question.trim().length === 0 ||
                            !selectedProject ||
                            !selectedIncident
                          }
                        >
                          {isSubmitting ? (
                            <>
                              <span
                                className="loading-spinner"
                                aria-hidden="true"
                              />
                              Investigando...
                            </>
                          ) : (
                            "Iniciar investigación"
                          )}
                        </button>
                      </div>
                    </form>

                    {investigationError ? (
                      <div className="inline-error investigation-error" role="alert">
                        <span>{investigationError}</span>
                        <button
                          type="button"
                          onClick={() => void runInvestigation(lastQuestion)}
                          disabled={isSubmitting || !lastQuestion}
                        >
                          Reintentar
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="investigation-empty">
                    Selecciona un incidente para enviar una consulta a la API
                    de investigación.
                  </div>
                )}

                {isSubmitting ? (
                  <div className="investigation-loading" role="status">
                    <span className="loading-spinner" aria-hidden="true" />
                    <div>
                      <strong>Recuperando evidencia y preparando respuesta</strong>
                      <p>
                        El contexto del incidente permanece disponible
                        mientras se procesa la consulta.
                      </p>
                    </div>
                  </div>
                ) : null}

                {result ? (
                  <section
                    className="response-card"
                    aria-labelledby="response-title"
                    aria-live="polite"
                  >
                    <div className="response-heading">
                      <div>
                        <p className="panel-kicker">RESULTADO DE INVESTIGACIÓN</p>
                        <h3 id="response-title">
                          {result.evidence.length > 0
                            ? "Respuesta basada en evidencia"
                            : "Evidencia insuficiente"}
                        </h3>
                      </div>
                      <span className="model-label">
                        {result.model === "not-invoked"
                          ? "Modelo no invocado"
                          : result.model}
                      </span>
                    </div>

                    {result.evidence.length === 0 ? (
                      <div className="abstention-notice">
                        No se encontraron fragmentos suficientemente
                        relevantes. La respuesta no se generó a partir de una
                        salida del modelo.
                      </div>
                    ) : null}

                    {syntheticEvidence ? (
                      <div className="synthetic-notice">
                        <strong>SYNTHETIC DEMO DATA</strong>
                        <span>
                          La evidencia contiene una marca explícita de datos
                          sintéticos. No demuestra ejecución ni uso en
                          producción.
                        </span>
                      </div>
                    ) : null}

                    {result.verifiedInvestigationResult ? (
                      <section className="response-section" aria-labelledby="verified-observations-title">
                        <h4 id="verified-observations-title">Hechos verificados</h4>
                        <p>
                          {result.verifiedInvestigationResult.aiAnalysis.status === "validated"
                            ? "Estos valores provienen de evidencia atestada; el análisis AI se muestra por separado."
                            : "El análisis AI no está validado; se presentan únicamente los hechos atestados."}
                        </p>
                        <ul>
                          {result.verifiedInvestigationResult.verifiedObservations.map((observation) => (
                            <li key={`${observation.eventId}:${observation.property}`}>
                              <code>{observation.property}</code>: {String(observation.value)}{observation.unit ? ` ${observation.unit}` : ""} [{observation.evidenceAlias}]
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}

                    {result.deterministicInvestigationResult ? (
                      <section className="response-section" aria-labelledby="deterministic-result-title">
                        <h4 id="deterministic-result-title">Investigación determinista</h4>
                        <p>
                          Modo: {result.deterministicInvestigationResult.mode}. Enriquecimiento IA: {result.deterministicInvestigationResult.aiEnrichment.status}. Gate de producto V2: {result.deterministicInvestigationResult.gateResult.status}.
                        </p>
                        <h5>VERIFIED OBSERVATION</h5>
                        <ul>{result.deterministicInvestigationResult.verifiedObservations.map((observation) => <li key={`${observation.eventId}:${observation.property}`}><code>{observation.property}</code>: {String(observation.value)}{observation.unit ? ` ${observation.unit}` : ""} [{observation.evidenceAlias}]</li>)}</ul>
                        <h5>DETECTED PATTERN</h5>
                        <ul>{result.deterministicInvestigationResult.detectedPatterns.length > 0 ? result.deterministicInvestigationResult.detectedPatterns.map((pattern) => <li key={pattern.ruleId}>{pattern.description}</li>) : <li>No se detectó un patrón con evidencia suficiente.</li>}</ul>
                        <h5>UNCONFIRMED HYPOTHESIS</h5>
                        <ul>{result.deterministicInvestigationResult.hypotheses.map((hypothesis) => <li key={hypothesis.statement}>{hypothesis.statement}</li>)}</ul>
                        <h5>Comprobaciones recomendadas</h5>
                        <ul>{result.deterministicInvestigationResult.recommendedChecks.map((check) => <li key={check}>{check}</li>)}</ul>
                      </section>
                    ) : null}

                    <div className="response-sections">
                      {splitResponseSections(result.response).map(
                        (section, index) => (
                          <section
                            className="response-section"
                            key={`${section.title ?? "respuesta"}-${index}`}
                          >
                            {section.title ? <h4>{section.title}</h4> : null}
                            <p>
                              {section.content.split(/\r?\n/u).map(
                                (line, lineIndex) => (
                                  <span
                                    key={`${index}-${lineIndex}`}
                                    className={
                                      line.length === 0
                                        ? "response-line response-line--empty"
                                        : "response-line"
                                    }
                                  >
                                    {renderCitations(
                                      line,
                                      result.evidence,
                                      focusEvidence,
                                    )}
                                    <br />
                                  </span>
                                ),
                              )}
                            </p>
                          </section>
                        ),
                      )}
                    </div>
                  </section>
                ) : null}
              </section>
            </section>

            <aside className="evidence-panel" aria-labelledby="evidence-title">
              <div className="evidence-panel-heading">
                <div>
                  <p className="panel-kicker">FUENTES RECUPERADAS</p>
                  <h2 id="evidence-title">Evidencias</h2>
                </div>
                <span className="evidence-total">
                  {result?.evidence.length ?? 0}
                </span>
              </div>

              {result && result.evidence.length > 0 ? (
                <>
                  <p className="evidence-explainer">
                    La similitud es una señal de recuperación semántica; no
                    representa probabilidad ni confianza causal.
                  </p>
                  <div className="evidence-list">
                    {result.evidence.map((item, index) => (
                      <article
                        className={`evidence-card ${
                          expandedEvidenceId === item.evidenceId
                            ? "evidence-card--selected"
                            : ""
                        }`}
                        id={`evidence-${item.evidenceId}`}
                        key={item.evidenceId}
                      >
                        <div className="evidence-card-top">
                          <span className="evidence-reference">
                            E{index + 1}
                          </span>
                          <span
                            className="evidence-similarity"
                            title="Similitud de recuperación; no mide confianza causal"
                            aria-label={`Similitud de recuperación: ${item.score.toFixed(3)}`}
                          >
                            Sim. {item.score.toFixed(3)}
                          </span>
                        </div>
                        <p className="evidence-document">
                          Documento{" "}
                          <span title={item.documentId}>
                            {item.documentId}
                          </span>
                        </p>
                        <p className="evidence-ordinal">
                          Fragmento {item.ordinal}
                        </p>
                        <button
                          className="evidence-toggle"
                          type="button"
                          aria-expanded={expandedEvidenceId === item.evidenceId}
                          onClick={() =>
                            setExpandedEvidenceId((current) =>
                              current === item.evidenceId ? "" : item.evidenceId,
                            )
                          }
                        >
                          {expandedEvidenceId === item.evidenceId
                            ? "Contraer contenido"
                            : "Consultar contenido"}
                        </button>
                        {expandedEvidenceId === item.evidenceId ? (
                          <pre className="evidence-content">
                            {item.content}
                          </pre>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="evidence-empty">
                  <span aria-hidden="true">E</span>
                  <p>
                    {result
                      ? "La API no devolvió evidencia suficiente para esta consulta."
                      : "Las fuentes utilizadas aparecerán aquí después de una investigación."}
                  </p>
                </div>
              )}
            </aside>
          </div>

          <footer className="workspace-footer">
            <span>
              {selectedProject
                ? `${selectedProject.name} · ${selectedWorkspace?.name ?? ""}`
                : "Selecciona un proyecto para consultar su contexto"}
            </span>
            <span>Similitud de recuperación ≠ confianza causal</span>
          </footer>
        </section>
      </div>
    </main>
  );
}
