"use client";

import {
  answerQaQuestion,
  importanceLabel,
  isQaImportResult,
  type QaFinding,
  type QaImportResult,
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

function AnalysisReport({ result }: { result: QaImportResult }) {
  const { analysis, repository } = result;
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
        Se inspeccionaron {repository.inspectedFileCount} {repository.inspectedFileCount === 1 ? "archivo de texto" : "archivos de texto"} del repositorio público. {analysis.findings.length === 0
          ? "No se encontraron problemas mediante las comprobaciones ejecutadas."
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
          <dd>No ejecutadas</dd>
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
            <h4>Límites</h4>
            <ul>{analysis.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul>
          </div>
        </div>
      </details>
      {(repository.skipped.invalidPath + repository.skipped.limitReached + repository.skipped.tooLarge) > 0 ? (
        <p className="qa-scope-note">
          Se omitieron {repository.skipped.invalidPath + repository.skipped.limitReached + repository.skipped.tooLarge} entradas por validación o límites de inspección. Las extensiones no compatibles también se excluyen por diseño.
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

  function selectProject(nextProjectId: string) {
    importController.current?.abort();
    setProjectId(nextProjectId);
    setAnalysisResult(null);
    setImportError("");
    setMessages([
      {
        id: `project-${nextProjectId}`,
        role: "assistant",
        text: "Proyecto cambiado. Importa un repositorio público para iniciar un nuevo análisis de QA.",
      },
    ]);
  }

  async function importRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || isImporting) return;
    const payload = { repositoryUrl: repositoryUrl.trim() };
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
    setQuestion("");
  }

  return (
    <main className="qa-app">
      <aside className="qa-sidebar" aria-label="Navegación de QA">
        <a className="qa-brand" href="/qa" aria-label="SentinelOps QA, inicio">
          <span aria-hidden="true">S</span>
          <strong>SentinelOps <small>QA</small></strong>
        </a>
        <nav className="qa-nav">
          <a className="qa-nav-active" href="/qa">Asistente de QA</a>
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
        <p className="qa-sidebar-note">MVP: repositorios públicos de GitHub y análisis estático. Las cargas ZIP y la ejecución aislada de pruebas aún no están disponibles.</p>
      </aside>

      <section className="qa-main" aria-labelledby="qa-title">
        <header className="qa-topbar">
          <div>
            <p className="qa-kicker">ASISTENTE DE CALIDAD · EVIDENCIA PRIMERO</p>
            <h1 id="qa-title">Entiende la calidad de tu proyecto sin ejecutar código no confiable.</h1>
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
