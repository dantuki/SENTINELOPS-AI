"use client";

import {
  answerQaQuestion,
  importanceLabel,
  isQaImportResult,
  isQaPersistedAnalysis,
  type QaConversation,
  type QaConversationMessage,
  type QaFinding,
  type QaImportResult,
  type QaPersistedAnalysis,
} from "@/lib/qa-presentation";
import { isGithubQaRequest } from "@/lib/qa-request";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

interface Workspace {
  id: string;
  name: string;
}

interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

function isConversation(value: unknown): value is QaConversation {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "projectId" in value && typeof value.projectId === "string" &&
    "title" in value && typeof value.title === "string" &&
    "isPinned" in value && typeof value.isPinned === "boolean" &&
    "createdAt" in value && typeof value.createdAt === "string" &&
    "updatedAt" in value && typeof value.updatedAt === "string" &&
    "lastMessageAt" in value && typeof value.lastMessageAt === "string";
}

function isConversationMessage(value: unknown): value is QaConversationMessage {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "role" in value && ["user", "assistant", "system"].includes(String(value.role)) &&
    "body" in value && typeof value.body === "string";
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value && typeof value.id === "string" &&
    "name" in value && typeof value.name === "string"
  );
}

function isProject(value: unknown): value is Project {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value && typeof value.id === "string" &&
    "workspaceId" in value && typeof value.workspaceId === "string" &&
    "name" in value && typeof value.name === "string" &&
    "description" in value &&
    (typeof value.description === "string" || value.description === null)
  );
}

function dataArray<T>(value: unknown, isItem: (item: unknown) => item is T): T[] | null {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
    return null;
  }
  return value.data.every(isItem) ? value.data : null;
}

function safeApiError(status: number): string {
  const known: Record<number, string> = {
    400: "Revisa la URL del repositorio.",
    401: "Tu sesión ya no es válida. Inicia sesión de nuevo.",
    403: "No tienes permiso para importar en este proyecto.",
    404: "No se encontró el proyecto o el repositorio público.",
    409: "Ese origen no está disponible para este proyecto.",
    422: "El repositorio no cumple los límites o las reglas de importación segura.",
    502: "GitHub devolvió una respuesta no válida para el análisis.",
    503: "El servicio de importación no está disponible temporalmente.",
    504: "La importación tardó demasiado. Puedes intentarlo de nuevo.",
  };
  return known[status] ?? "No se pudo completar el análisis.";
}

function FindingCard({ finding }: { finding: QaFinding }) {
  return (
    <article className="qa-finding-card">
      <div className="qa-finding-heading">
        <span className={`qa-importance qa-importance--${finding.importance}`}>
          {importanceLabel(finding.importance)}
        </span>
        <span className="qa-finding-category">{finding.category}</span>
      </div>
      <h4>{finding.title}</h4>
      <p>{finding.description}</p>
      <dl className="qa-finding-details">
        <div>
          <dt>Por qué importa</dt>
          <dd>{finding.whyItMatters}</dd>
        </div>
        <div>
          <dt>Cómo comprobar/corregir</dt>
          <dd>{finding.recommendation}</dd>
        </div>
      </dl>
      <details className="qa-evidence">
        <summary>Ver evidencia verificable</summary>
        <p>
          <code>{finding.evidence.filePath}</code> · línea {finding.evidence.startLine}
        </p>
        <pre><code>{finding.evidence.excerpt}</code></pre>
        <p className="qa-evidence-note">
          Identidad de contenido: <code>{finding.evidence.contentSha256}</code>
        </p>
      </details>
    </article>
  );
}

function HistoricalFindingCard({ finding }: { finding: QaPersistedAnalysis["findings"][number] }) {
  return (
    <article className="qa-finding-card">
      <div className="qa-finding-heading">
        <span className={`qa-importance qa-importance--${finding.importance}`}>
          {importanceLabel(finding.importance)}
        </span>
        <span className="qa-finding-category">{finding.category}</span>
      </div>
      <h4>{finding.title}</h4>
      <p>{finding.description}</p>
      <dl className="qa-finding-details">
        <div>
          <dt>Cómo comprobar/corregir</dt>
          <dd>{finding.recommendation}</dd>
        </div>
      </dl>
      <details className="qa-evidence">
        <summary>Ver referencia de evidencia persistida</summary>
        <p>
          <code>{finding.evidence.filePath}</code> · líneas {finding.evidence.startLine}–{finding.evidence.endLine}
        </p>
        <p className="qa-evidence-note">
          Identidad de contenido: <code>{finding.evidence.contentSha256}</code>
        </p>
        <p className="qa-evidence-note">El extracto no se retuvo por diseño; esta referencia no reconstruye contenido del repositorio.</p>
      </details>
    </article>
  );
}

function HistoricalAnalysisReport({ analysis }: { analysis: QaPersistedAnalysis }) {
  return (
    <section className="qa-analysis-report" aria-labelledby={`qa-historical-report-${analysis.id}`}>
      <header className="qa-report-heading">
        <div>
          <p className="qa-kicker">INFORME PERSISTIDO · REFERENCIAS VERIFICABLES</p>
          <h3 id={`qa-historical-report-${analysis.id}`}>{analysis.repositoryUrl}</h3>
        </div>
        <span className="qa-source-state">Completado</span>
      </header>
      <p className="qa-report-summary">
        Este informe conservó {analysis.reportSummary.findingCount} {analysis.reportSummary.findingCount === 1 ? "hallazgo verificable" : "hallazgos verificables"} y metadatos de {analysis.reportSummary.inspectedFileCount} archivos inspeccionados. No reconstruye cuerpos ni extractos que no fueron persistidos.
      </p>
      <dl className="qa-report-meta">
        <div>
          <dt>Revisión</dt>
          <dd><code>{analysis.revision.slice(0, 12)}</code></dd>
        </div>
        <div>
          <dt>Stack detectado</dt>
          <dd>{analysis.reportSummary.detectedStack.length > 0 ? analysis.reportSummary.detectedStack.join(" · ") : "No identificado por las reglas actuales"}</dd>
        </div>
        <div>
          <dt>Pruebas del repositorio</dt>
          <dd>{analysis.reportSummary.testExecution.reason}</dd>
        </div>
      </dl>
      <div className="qa-report-section">
        <h4>Hallazgos y referencias retenidas</h4>
        {analysis.findings.length > 0 ? (
          <div className="qa-findings-grid">
            {analysis.findings.map((finding) => <HistoricalFindingCard key={finding.id} finding={finding} />)}
          </div>
        ) : (
          <p className="qa-empty">Las comprobaciones estáticas ejecutadas no produjeron hallazgos. Esto no equivale a que el proyecto esté libre de defectos o vulnerabilidades.</p>
        )}
      </div>
      <details className="qa-report-details">
        <summary>Límites del informe persistido</summary>
        <ul>{analysis.reportSummary.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul>
      </details>
    </section>
  );
}

function AnalysisReport({ result }: { result: QaImportResult }) {
  const { analysis, repository } = result;
  const missingTestScript = analysis.findings.some((finding) => finding.ruleId === "qa.testing.missing_test_script");
  const testScriptState = analysis.inspectedFiles.some((file) => file.path === "package.json")
    ? (missingTestScript ? "No declarado en el package.json inspeccionado" : "Declarado en el package.json inspeccionado")
    : "Desconocido: package.json no formó parte de la muestra";
  const omittedFiles = Math.max(0, repository.inventory.discoveredFiles - repository.inventory.selectedFiles);
  return (
    <section className="qa-analysis-report" aria-labelledby="qa-report-title">
      <header className="qa-report-heading">
        <div>
          <p className="qa-kicker">ANÁLISIS ESTÁTICO VERIFICABLE</p>
          <h3 id="qa-report-title">{repository.owner}/{repository.name}</h3>
        </div>
        <span className="qa-source-state">
          {result.source.created ? "Origen añadido" : "Origen actualizado"}
        </span>
      </header>
      <p className="qa-report-summary">
        El repositorio público tiene {repository.inventory.discoveredFiles} archivos inventariados por metadatos y se inspeccionaron {repository.inspectedFileCount} {repository.inspectedFileCount === 1 ? "archivo de texto" : "archivos de texto"} seleccionados por categoría. {analysis.findings.length === 0
          ? "Las comprobaciones estáticas sobre esa muestra no produjeron hallazgos."
          : `Se encontraron ${analysis.findings.length} ${analysis.findings.length === 1 ? "hallazgo verificable" : "hallazgos verificables"}.`}
      </p>
      <dl className="qa-report-meta">
        <div>
          <dt>Stack detectado</dt>
          <dd>{analysis.detectedStack.length > 0 ? analysis.detectedStack.join(" · ") : "No identificado por las reglas actuales"}</dd>
        </div>
        <div>
          <dt>Rama / revisión</dt>
          <dd><code>{repository.defaultBranch}</code> · <code>{repository.revision.slice(0, 12)}</code></dd>
        </div>
        <div>
          <dt>Pruebas del repositorio</dt>
          <dd>{analysis.inventory.testFiles.discovered > 0
            ? `${analysis.inventory.testFiles.discovered} rutas detectadas; ${analysis.inventory.testFiles.selected} inspeccionadas`
            : "No observadas en las rutas inventariadas"}</dd>
        </div>
      </dl>
      <div className="qa-report-section">
        <h4>Qué encontré</h4>
        {analysis.findings.length > 0 ? (
          <div className="qa-findings-grid">
            {analysis.findings.map((finding) => <FindingCard key={finding.id} finding={finding} />)}
          </div>
        ) : (
          <p className="qa-empty">Las comprobaciones estáticas ejecutadas no produjeron hallazgos. Esto no equivale a que el proyecto esté libre de defectos o vulnerabilidades.</p>
        )}
      </div>
      <details className="qa-report-details">
        <summary>Comprobaciones y límites del análisis</summary>
        <div className="qa-report-details-grid">
          <div>
            <h4>Comprobaciones realizadas</h4>
            <ul>{analysis.checksPerformed.map((check) => <li key={check}>{check}</li>)}</ul>
          </div>
          <div>
            <h4>No ejecutado</h4>
            <p>{analysis.testExecution.reason}</p>
          </div>
          <div>
            <h4>Pruebas: declaración e inventario</h4>
            <p>Script: {testScriptState}.</p>
            <p>Rutas de prueba detectadas: {analysis.inventory.testFiles.discovered}; descargadas en la muestra: {analysis.inventory.testFiles.selected}; ejecución: no ejecutada.</p>
          </div>
          <div>
            <h4>Cobertura de la muestra</h4>
            <ul>{repository.inventory.categories.map((category) => (
              <li key={category.category}>{category.category}: {category.selected} seleccionados de {category.discovered} inventariados</li>
            ))}</ul>
          </div>
          <div>
            <h4>Límites</h4>
            <ul>{analysis.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul>
          </div>
        </div>
      </details>
      {omittedFiles > 0 || (repository.skipped.invalidPath + repository.skipped.limitReached + repository.skipped.tooLarge) > 0 ? (
        <p className="qa-scope-note">
          {omittedFiles > 0 ? `${omittedFiles} archivos inventariados no se descargaron por el muestreo y sus límites. ` : ""}Se excluyeron {repository.skipped.invalidPath + repository.skipped.limitReached + repository.skipped.tooLarge} entradas adicionales por validación, tamaño o límites. Las extensiones no compatibles también se excluyen por diseño; no se concluye que se revisó todo el repositorio.
        </p>
      ) : null}
    </section>
  );
}

export function QaWorkspace() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [loadingSelection, setLoadingSelection] = useState(true);
  const [selectionError, setSelectionError] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [analysisResult, setAnalysisResult] = useState<QaImportResult | null>(null);
  const [persistedAnalyses, setPersistedAnalyses] = useState<QaPersistedAnalysis[]>([]);
  const [conversations, setConversations] = useState<QaConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Conecta un repositorio público de GitHub para realizar un análisis estático verificable. No ejecutaré código, instalaciones ni pruebas del repositorio.",
    },
  ]);
  const importController = useRef<AbortController | null>(null);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projectId, projects],
  );

  useEffect(() => {
    const controller = new AbortController();
    async function loadWorkspaces() {
      try {
        const response = await fetch("/api/workspaces", { signal: controller.signal, cache: "no-store" });
        const payload: unknown = await response.json();
        const data = response.ok ? dataArray(payload, isWorkspace) : null;
        if (!data) throw new Error("invalid workspace response");
        setWorkspaces(data);
        setWorkspaceId((current) => current || data[0]?.id || "");
      } catch (error: unknown) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSelectionError("No se pudieron cargar los workspaces autorizados.");
        }
      } finally {
        if (!controller.signal.aborted) setLoadingSelection(false);
      }
    }
    void loadWorkspaces();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      setProjectId("");
      return;
    }
    const controller = new AbortController();
    async function loadProjects() {
      setSelectionError("");
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload: unknown = await response.json();
        const data = response.ok ? dataArray(payload, isProject) : null;
        if (!data) throw new Error("invalid project response");
        setProjects(data);
        setProjectId((current) => data.some((project) => project.id === current) ? current : data[0]?.id || "");
      } catch (error: unknown) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSelectionError("No se pudieron cargar los proyectos autorizados.");
        }
      }
    }
    void loadProjects();
    return () => controller.abort();
  }, [workspaceId]);

  useEffect(() => () => importController.current?.abort(), []);

  async function loadConversations(nextProjectId = projectId) {
    if (!nextProjectId) {
      setConversations([]);
      return;
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(nextProjectId)}/qa/conversations`, { cache: "no-store" });
      const payload: unknown = await response.json();
      const data = response.ok && payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
        ? payload.data.filter(isConversation)
        : null;
      if (!data) throw new Error("history unavailable");
      setConversations(data);
      setHistoryError("");
    } catch {
      setConversations([]);
      setHistoryError("El historial persistente estará disponible cuando la memoria de QA esté configurada.");
    }
  }

  useEffect(() => {
    void loadConversations();
  // The project is the only external input for the history fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function selectProject(nextProjectId: string) {
    importController.current?.abort();
    setProjectId(nextProjectId);
    setAnalysisResult(null);
    setPersistedAnalyses([]);
    setActiveConversationId("");
    setImportError("");
    setMessages([
      {
        id: `project-${nextProjectId}`,
        role: "assistant",
        text: "Proyecto cambiado. Importa un repositorio público para iniciar un nuevo análisis de QA.",
      },
    ]);
  }

  function startNewAnalysis() {
    importController.current?.abort();
    setActiveConversationId("");
    setAnalysisResult(null);
    setPersistedAnalyses([]);
    setImportError("");
    setMessages([{ id: `new-${Date.now()}`, role: "assistant", text: "Nuevo análisis. Conecta un repositorio público de GitHub para crear un informe verificable." }]);
  }

  async function openConversation(conversation: QaConversation) {
    if (!projectId || conversation.id === activeConversationId) return;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(conversation.id)}`, { cache: "no-store" });
      const payload: unknown = await response.json();
      const data = response.ok && payload && typeof payload === "object" && "data" in payload && typeof payload.data === "object" && payload.data !== null
        ? payload.data as { messages?: unknown; analyses?: unknown }
        : null;
      if (
        !data ||
        !Array.isArray(data.messages) ||
        !data.messages.every(isConversationMessage) ||
        !Array.isArray(data.analyses) ||
        !data.analyses.every(isQaPersistedAnalysis)
      ) throw new Error("invalid history");
      setActiveConversationId(conversation.id);
      setAnalysisResult(null);
      setPersistedAnalyses(data.analyses);
      setMessages(data.messages.map((message) => ({
        id: message.id,
        role: message.role === "user" ? "user" : "assistant",
        text: message.body,
      })));
      setHistoryError("");
    } catch {
      setHistoryError("No se pudo abrir esta conversación. Verifica que sigues teniendo acceso al proyecto.");
    }
  }

  async function togglePinned(conversation: QaConversation) {
    if (!projectId) return;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPinned: !conversation.isPinned }),
      });
      if (!response.ok) throw new Error("pin failed");
      await loadConversations();
    } catch {
      setHistoryError("No se pudo actualizar el fijado de la conversación.");
    }
  }

  async function importRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || isImporting) return;
    const payload = { repositoryUrl: repositoryUrl.trim(), ...(activeConversationId ? { conversationId: activeConversationId } : {}) };
    if (!isGithubQaRequest(payload)) {
      setImportError("Introduce una URL de repositorio público de GitHub.");
      return;
    }
    importController.current?.abort();
    const controller = new AbortController();
    importController.current = controller;
    setIsImporting(true);
    setImportError("");
    setMessages((current) => [...current, { id: `import-${Date.now()}`, role: "user", text: payload.repositoryUrl }]);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/qa/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const responsePayload: unknown = await response.json();
      if (!response.ok || !responsePayload || typeof responsePayload !== "object" || !("data" in responsePayload)) {
        throw new Error(String(response.status));
      }
      const result = responsePayload.data;
      if (!isQaImportResult(result)) throw new Error(String(response.status));
      setAnalysisResult(result);
      setPersistedAnalyses([]);
      if (result.conversation) {
        setActiveConversationId(result.conversation.id);
        await loadConversations();
      }
      if (result.persistence?.status === "unavailable") {
        setHistoryError("El informe sigue disponible en esta sesión, pero no se pudo guardar en el historial.");
      } else {
        setHistoryError("");
      }
      setMessages((current) => [...current, {
        id: `report-${result.analysis.analysisId}`,
        role: "assistant",
        text: `Análisis completado: ${result.analysis.findings.length} hallazgos verificables en ${result.repository.inspectedFileCount} archivos inspeccionados.`,
      }]);
      setRepositoryUrl("");
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const status = Number(error instanceof Error ? error.message : NaN);
      setImportError(safeApiError(status));
    } finally {
      if (importController.current === controller) {
        importController.current = null;
        setIsImporting(false);
      }
    }
  }

  function askAboutAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || !analysisResult) return;
    setMessages((current) => [
      ...current,
      { id: `question-${Date.now()}`, role: "user", text: trimmed },
      {
        id: `answer-${Date.now()}`,
        role: "assistant",
        text: answerQaQuestion(trimmed, analysisResult.analysis),
      },
    ]);
    if (activeConversationId && projectId) {
      void Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(activeConversationId)}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "user", body: trimmed }),
        }),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(activeConversationId)}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "assistant", body: answerQaQuestion(trimmed, analysisResult.analysis) }),
        }),
      ]).then(() => loadConversations()).catch(() => setHistoryError("La respuesta se mostró en esta sesión, pero no se pudo guardar en el historial."));
    }
    setQuestion("");
  }

  return (
    <main className="qa-app">
      <aside className="qa-sidebar" aria-label="Navegación de QA">
        <a className="qa-brand" href="/qa" aria-label="SentinelOps QA, inicio">
          <span className="qa-brand-mark" aria-hidden="true">S</span>
          <span className="qa-brand-name">SentinelOps <small>QA</small></span>
        </a>
        <nav className="qa-nav">
          <button className="qa-nav-active" type="button" onClick={startNewAnalysis}>Nuevo análisis</button>
          <a href="/knowledge-base">Fuentes técnicas</a>
          <a href="/investigation">Investigación avanzada</a>
        </nav>
        <section className="qa-context" aria-label="Proyecto seleccionado">
          <p className="qa-kicker">CONTEXTO DE ANÁLISIS</p>
          <label htmlFor="qa-workspace">Workspace</label>
          <select id="qa-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={loadingSelection || workspaces.length === 0}>
            <option value="">{loadingSelection ? "Cargando..." : "Sin workspaces"}</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <label htmlFor="qa-project">Proyecto</label>
          <select id="qa-project" value={projectId} onChange={(event) => selectProject(event.target.value)} disabled={!workspaceId || projects.length === 0}>
            <option value="">{workspaceId ? "Selecciona un proyecto" : "Selecciona primero un workspace"}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          {selectedProject?.description ? <p>{selectedProject.description}</p> : null}
          {selectionError ? <p className="qa-context-error" role="alert">{selectionError}</p> : null}
        </section>
        <section className="qa-history" aria-label="Conversaciones del proyecto">
          <div className="qa-history-heading">
            <p className="qa-kicker">CONVERSACIONES</p>
            <span>{conversations.length}</span>
          </div>
          {conversations.length > 0 ? (
            <ul>
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button className={conversation.id === activeConversationId ? "qa-history-active" : ""} type="button" onClick={() => void openConversation(conversation)}>
                    <span>{conversation.isPinned ? "★ " : ""}{conversation.title}</span>
                    <small>{new Date(conversation.lastMessageAt).toLocaleDateString("es-CO")}</small>
                  </button>
                  <button className="qa-pin-button" type="button" onClick={() => void togglePinned(conversation)} aria-label={conversation.isPinned ? "Quitar fijado" : "Fijar conversación"}>{conversation.isPinned ? "★" : "☆"}</button>
                </li>
              ))}
            </ul>
          ) : <p className="qa-sidebar-note">Aún no hay conversaciones guardadas para este proyecto.</p>}
          {historyError ? <p className="qa-context-error" role="status">{historyError}</p> : null}
        </section>
        <p className="qa-sidebar-note">MVP: repositorios públicos de GitHub y análisis estático. Las cargas ZIP y la ejecución aislada de pruebas aún no están disponibles.</p>
      </aside>

      <section className="qa-main" aria-labelledby="qa-title">
        <header className="qa-topbar">
          <div>
            <p className="qa-kicker">{activeConversationId ? "CONVERSACIÓN DE PROYECTO" : "NUEVO ANÁLISIS"} · EVIDENCIA PRIMERO</p>
            <h1 id="qa-title">{analysisResult ? `Encontré ${analysisResult.analysis.findings.length} hallazgos verificables.` : "Entiende la calidad de tu proyecto sin ejecutar código no confiable."}</h1>
          </div>
          <span className="qa-readonly">Análisis estático · solo lectura</span>
        </header>

        <div className="qa-conversation" aria-live="polite">
          {messages.map((message) => (
            <article className={`qa-message qa-message--${message.role}`} key={message.id}>
              <span className="qa-message-role">{message.role === "assistant" ? "SentinelOps QA" : "Tú"}</span>
              <p>{message.text}</p>
            </article>
          ))}
          {analysisResult ? <AnalysisReport result={analysisResult} /> : null}
          {!analysisResult ? persistedAnalyses.map((analysis) => <HistoricalAnalysisReport key={analysis.id} analysis={analysis} />) : null}
        </div>

        {!analysisResult ? (
          <form className="qa-import-composer" onSubmit={importRepository}>
            <label htmlFor="qa-repository">Repositorio público de GitHub</label>
            <div>
              <input
                id="qa-repository"
                type="url"
                inputMode="url"
                placeholder="https://github.com/owner/repository"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                disabled={!projectId || isImporting}
                required
              />
              <button type="submit" disabled={!projectId || isImporting}>{isImporting ? "Analizando…" : "Importar y analizar"}</button>
            </div>
            <p>Solo se consulta GitHub mediante su API pública, con límites de tamaño y sin ejecutar scripts, instalaciones ni pruebas.</p>
            {importError ? <p className="qa-import-error" role="alert">{importError}</p> : null}
          </form>
        ) : (
          <form className="qa-question-composer" onSubmit={askAboutAnalysis}>
            <label htmlFor="qa-question">Pregunta sobre este análisis</label>
            <div>
              <input
                id="qa-question"
                placeholder="Ej.: ¿Qué encontraste y dónde ocurre?"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <button type="submit" disabled={!question.trim()}>Preguntar</button>
            </div>
            <div className="qa-question-suggestions" aria-label="Preguntas sugeridas">
              <button type="button" onClick={() => setQuestion("¿Qué encontraste?")}>Qué encontraste</button>
              <button type="button" onClick={() => setQuestion("¿Dónde ocurre?")}>Ver ubicaciones</button>
              <button type="button" onClick={() => setQuestion("¿Qué pruebas se ejecutaron?")}>Estado de pruebas</button>
              <button type="button" onClick={() => setQuestion("¿Cómo lo corrijo?")}>Cómo corregir</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
