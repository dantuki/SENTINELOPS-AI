"use client";

import { ProductApiStatus } from "@/components/product-api-status";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
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
  status: "active" | "archived";
}

interface ProjectSource {
  id: string;
  sourceType: "file_upload" | "git_repository" | "web_url" | "manual" | "log_bundle";
  name: string;
  locator: string;
  status: "pending" | "active" | "disabled" | "failed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProjectDocument {
  id: string;
  sourceId: string;
  sourceDocumentKey: string | null;
  title: string;
  mediaType: string | null;
  contentSha256: string | null;
  status: "discovered" | "processing" | "indexed" | "failed" | "archived";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface IngestionResponse {
  documentId: string;
  name: string;
  status: ProjectDocument["status"];
  deduplicated: boolean;
  chunksCreated: number;
  embeddingsCreated: number;
  model: string | null;
}

interface ApiEnvelope<T> {
  data: T;
}

const sourceStatusLabels: Record<ProjectSource["status"], string> = {
  pending: "Pendiente",
  active: "Activa",
  disabled: "Deshabilitada",
  failed: "Con errores",
};

const sourceTypeLabels: Record<ProjectSource["sourceType"], string> = {
  file_upload: "Archivos",
  git_repository: "Repositorio Git",
  web_url: "URL web",
  manual: "Manual",
  log_bundle: "Paquete de logs",
};

const documentStatusLabels: Record<ProjectDocument["status"], string> = {
  discovered: "Pendiente",
  processing: "Procesando",
  indexed: "Indexado",
  failed: "Error",
  archived: "Archivado",
};

const ingestionErrorLabels: Record<string, string> = {
  chunk_content_conflict: "El contenido del fragmento cambió; vuelve a cargar el archivo.",
  embedding_indexing_conflict: "No se pudieron guardar todos los embeddings; reintenta.",
  embedding_service_unavailable: "El servicio de embeddings no está disponible.",
  embedding_service_timeout: "El servicio de embeddings tardó demasiado; reintenta.",
  ingestion_processing_failed: "Falló el procesamiento; puedes reintentarlo.",
  invalid_embedding_response: "El servicio de embeddings respondió con datos inválidos.",
  too_many_chunks: "El archivo supera el límite de fragmentos por procesamiento.",
};

const ACCEPTED_FILE_HINT =
  "Texto, logs, JSON/JSONL, CSV, YAML, Markdown y archivos de código (máx. 200 KB por archivo). No se aceptan credenciales ni claves privadas.";

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
    (value.status === "active" || value.status === "archived")
  );
}

function isSource(value: unknown): value is ProjectSource {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["file_upload", "git_repository", "web_url", "manual", "log_bundle"].includes(
      String(value.sourceType),
    ) &&
    typeof value.name === "string" &&
    typeof value.locator === "string" &&
    ["pending", "active", "disabled", "failed"].includes(
      String(value.status),
    ) &&
    isRecord(value.metadata) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isDocument(value: unknown): value is ProjectDocument {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sourceId === "string" &&
    (typeof value.sourceDocumentKey === "string" ||
      value.sourceDocumentKey === null) &&
    typeof value.title === "string" &&
    (typeof value.mediaType === "string" || value.mediaType === null) &&
    (typeof value.contentSha256 === "string" ||
      value.contentSha256 === null) &&
    ["discovered", "processing", "indexed", "failed", "archived"].includes(
      String(value.status),
    ) &&
    isRecord(value.metadata) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isIngestionResponse(value: unknown): value is IngestionResponse {
  return (
    isRecord(value) &&
    typeof value.documentId === "string" &&
    typeof value.name === "string" &&
    ["discovered", "processing", "indexed", "failed", "archived"].includes(
      String(value.status),
    ) &&
    typeof value.deduplicated === "boolean" &&
    typeof value.chunksCreated === "number" &&
    Number.isInteger(value.chunksCreated) &&
    value.chunksCreated >= 0 &&
    typeof value.embeddingsCreated === "number" &&
    Number.isInteger(value.embeddingsCreated) &&
    value.embeddingsCreated >= 0 &&
    (typeof value.model === "string" || value.model === null)
  );
}

function isEnvelope<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is ApiEnvelope<T[]> {
  return (
    isRecord(value) &&
    Array.isArray(value.data) &&
    value.data.every(isItem)
  );
}

function parseError(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : fallback;
}

function getIngestionMetadata(
  document: ProjectDocument,
): Record<string, unknown> {
  return isRecord(document.metadata.ingestion)
    ? document.metadata.ingestion
    : {};
}

function humanizeIngestionError(value: unknown): string {
  if (typeof value !== "string") {
    return "Error durante la ingesta. Puedes reintentarlo.";
  }

  return (
    ingestionErrorLabels[value] ??
    "Error durante la ingesta. Revisa el archivo y vuelve a intentarlo."
  );
}

function fileTypeIsSupported(name: string): boolean {
  const allowed =
    /\.(?:bash|c|cc|cpp|cs|css|csv|go|graphql|h|hpp|html|ini|java|js|json|jsonl|jsx|kt|log|md|php|proto|ps1|py|rb|rs|rst|scss|sh|sql|toml|ts|tsx|txt|tsv|xml|yaml|yml)$/iu;

  return (
    allowed.test(name) ||
    [".dockerignore", ".editorconfig", ".gitignore"].includes(
      name.toLowerCase(),
    )
  );
}

async function fetchProjectList<T>(
  url: string,
  isItem: (value: unknown) => value is T,
  signal: AbortSignal,
): Promise<T[]> {
  const response = await fetch(url, { cache: "no-store", signal });
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new Error("La API devolvió una respuesta no válida.");
  }

  if (!response.ok) {
    throw new Error(
      parseError(payload, "No se pudieron cargar los datos del proyecto."),
    );
  }

  if (!isEnvelope(payload, isItem)) {
    throw new Error("La API devolvió datos incompletos.");
  }

  return payload.data;
}

function getFriendlyRequestError(status: number): string {
  if (status === 404) {
    return "No se encontró el proyecto o documento seleccionado.";
  }

  if (status === 409) {
    return "El documento está archivado o necesita que termine otro intento antes de reintentarlo.";
  }

  if (status === 413) {
    return "El archivo supera el límite de 200 KB.";
  }

  if (status === 415) {
    return "Tipo de archivo no compatible o archivo de credenciales detectado.";
  }

  if (status === 502 || status === 503 || status === 504) {
    return "No se pudo completar la ingesta. Comprueba PostgreSQL y el servicio local de embeddings, y reintenta.";
  }

  return "No se pudo completar la solicitud. Revisa el archivo e inténtalo de nuevo.";
}

export function KnowledgeBase() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [loadingError, setLoadingError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [operationNotice, setOperationNotice] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [importingDemo, setImportingDemo] = useState(false);
  const [retryingDocumentId, setRetryingDocumentId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const projectIdRef = useRef("");

  const selectProject = useCallback((nextProjectId: string) => {
    projectIdRef.current = nextProjectId;
    setProjectId(nextProjectId);
    setSelectedFiles([]);
    if (fileInput.current) {
      fileInput.current.value = "";
    }
  }, []);

  const refreshKnowledge = useCallback(async (selectedProjectId: string) => {
    const [nextSources, nextDocuments] = await Promise.all([
      fetchProjectList(
        `/api/projects/${encodeURIComponent(selectedProjectId)}/sources`,
        isSource,
        new AbortController().signal,
      ),
      fetchProjectList(
        `/api/projects/${encodeURIComponent(selectedProjectId)}/documents`,
        isDocument,
        new AbortController().signal,
      ),
    ]);

    if (projectIdRef.current !== selectedProjectId) {
      return;
    }

    setSources(nextSources);
    setDocuments(nextDocuments);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWorkspaces() {
      setLoadingWorkspaces(true);
      setLoadingError("");
      try {
        const items = await fetchProjectList(
          "/api/workspaces",
          isWorkspace,
          controller.signal,
        );
        setWorkspaces(items);
        setWorkspaceId(
          items.find((item) => item.status === "active")?.id ??
            items[0]?.id ??
            "",
        );
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setLoadingError(
            error instanceof Error
              ? error.message
              : "No se pudieron cargar los workspaces.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingWorkspaces(false);
        }
      }
    }

    void loadWorkspaces();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      selectProject("");
      return;
    }

    const controller = new AbortController();

    async function loadProjects() {
      setLoadingProjects(true);
      selectProject("");
      setLoadingError("");
      try {
        const items = await fetchProjectList(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`,
          isProject,
          controller.signal,
        );
        const ordered = [...items].sort((first, second) =>
          first.status === second.status
            ? first.name.localeCompare(second.name)
            : first.status === "active"
              ? -1
              : 1,
        );
        setProjects(ordered);
        selectProject(ordered[0]?.id ?? "");
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setLoadingError(
            error instanceof Error
              ? error.message
              : "No se pudieron cargar los proyectos.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingProjects(false);
        }
      }
    }

    void loadProjects();
    return () => controller.abort();
  }, [selectProject, workspaceId]);

  useEffect(() => {
    if (!projectId) {
      setSources([]);
      setDocuments([]);
      return;
    }

    let active = true;
    const controller = new AbortController();

    async function loadKnowledge() {
      setLoadingKnowledge(true);
      setLoadingError("");
      try {
        const [nextSources, nextDocuments] = await Promise.all([
          fetchProjectList(
            `/api/projects/${encodeURIComponent(projectId)}/sources`,
            isSource,
            controller.signal,
          ),
          fetchProjectList(
            `/api/projects/${encodeURIComponent(projectId)}/documents`,
            isDocument,
            controller.signal,
          ),
        ]);
        if (active) {
          setSources(nextSources);
          setDocuments(nextDocuments);
        }
      } catch (error: unknown) {
        if (active && !controller.signal.aborted) {
          setLoadingError(
            error instanceof Error
              ? error.message
              : "No se pudieron cargar las fuentes.",
          );
        }
      } finally {
        if (active) {
          setLoadingKnowledge(false);
        }
      }
    }

    void loadKnowledge();
    const intervalId = window.setInterval(() => {
      void loadKnowledge();
    }, 5_000);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [projectId]);

  const selectedProject = projects.find((project) => project.id === projectId);
  const indexedCount = documents.filter(
    (document) => document.status === "indexed",
  ).length;
  const processingCount = documents.filter(
    (document) => document.status === "processing",
  ).length;
  const failedCount = documents.filter(
    (document) => document.status === "failed",
  ).length;

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(Array.from(event.target.files ?? []));
    setOperationError("");
    setOperationNotice("");
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || selectedFiles.length === 0 || uploading) {
      return;
    }

    setUploading(true);
    setOperationError("");
    setOperationNotice("");
    const successMessages: string[] = [];
    const failureMessages: string[] = [];

    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index]!;
        setUploadProgress(`Procesando ${index + 1} de ${selectedFiles.length}: ${file.name}`);

        if (!fileTypeIsSupported(file.name)) {
          failureMessages.push(`${file.name}: tipo de archivo no permitido.`);
          continue;
        }

        if (file.size === 0 || file.size > 200_000) {
          failureMessages.push(`${file.name}: debe tener entre 1 byte y 200 KB.`);
          continue;
        }

        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          );
        } catch {
          failureMessages.push(`${file.name}: no es un archivo UTF-8 válido.`);
          continue;
        }

        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/ingestions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ name: file.name, content }),
          },
        );
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }

        if (!response.ok) {
          failureMessages.push(
            `${file.name}: ${getFriendlyRequestError(response.status)}`,
          );
          continue;
        }

        const data =
          isRecord(payload) && isRecord(payload.data)
            ? payload.data
            : null;
        if (!isIngestionResponse(data)) {
          failureMessages.push(
            `${file.name}: la API devolvió una respuesta no válida.`,
          );
          continue;
        }

        if (data.status === "failed" || data.status === "archived") {
          failureMessages.push(
            `${file.name}: el documento no está indexado (${documentStatusLabels[data.status]}).`,
          );
        } else {
          successMessages.push(
            data.status === "indexed" && data.deduplicated
              ? `${file.name}: contenido ya indexado; no se duplicó.`
              : data.status === "indexed"
                ? `${file.name}: procesado e indexado.`
                : data.status === "processing"
                  ? `${file.name}: la ingesta sigue procesándose.`
                  : `${file.name}: ingesta pendiente.`,
          );
        }
      }

      setSelectedFiles([]);
      if (fileInput.current) {
        fileInput.current.value = "";
      }
      if (projectIdRef.current === projectId) {
        setOperationNotice(successMessages.join("\n"));
        setOperationError(failureMessages.join("\n"));
      }
      await refreshKnowledge(projectId);
    } catch {
      if (projectIdRef.current === projectId) {
        setOperationError(
          "No se pudo completar la carga. Comprueba la conexión e inténtalo de nuevo.",
        );
      }
    } finally {
      setUploading(false);
      setUploadProgress("");
    }
  }

  async function handleDemoImport() {
    if (!projectId || importingDemo) {
      return;
    }

    setImportingDemo(true);
    setOperationError("");
    setOperationNotice("");

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/ingestions/demo`,
        { method: "POST", cache: "no-store" },
      );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        if (projectIdRef.current === projectId) {
          setOperationError(getFriendlyRequestError(response.status));
        }
        return;
      }

      const expectedFiles = [
        "observed-logs.jsonl",
        "retry-dispatcher.synthetic.ts",
      ];
      if (
        !isRecord(payload) ||
        !isRecord(payload.data) ||
        payload.data.dataset !== "sentinelops-synthetic-demo-v1" ||
        !Array.isArray(payload.data.files) ||
        payload.data.files.length !== expectedFiles.length ||
        !payload.data.files.every(isIngestionResponse)
      ) {
        throw new Error("La API devolvió un resultado de ingesta no válido.");
      }

      const files = payload.data.files;
      if (
        !expectedFiles.every((name) =>
          files.some((file) => file.name === name),
        ) ||
        files.some(
          (file) =>
            file.status !== "indexed" &&
            file.status !== "processing" &&
            file.status !== "archived",
        )
      ) {
        throw new Error("La API devolvió un estado de ingesta no válido.");
      }

      const allIndexed = files.every((file) => file.status === "indexed");
      const alreadyIndexed = files.every(
        (file) => file.deduplicated === true,
      );
      if (projectIdRef.current === projectId) {
        setOperationNotice(
          allIndexed && alreadyIndexed
            ? "El dataset sintético INC-001 ya estaba indexado; no se duplicó contenido."
            : allIndexed
              ? "Dataset sintético INC-001 importado e indexado. No se ejecutó código del dataset ni se ingirió ground-truth."
              : files.some(
                    (file) =>
                      file.status === "processing" ||
                      file.status === "discovered",
                  )
                ? "La importación sintética INC-001 continúa procesándose. No se ejecutó código del dataset ni se ingirió ground-truth."
                : "La importación aún no está indexada; revisa el estado de los documentos.",
        );
      }
      await refreshKnowledge(projectId);
    } catch (error: unknown) {
      if (projectIdRef.current === projectId) {
        setOperationError(
          error instanceof Error
            ? error.message
            : "No se pudo importar el dataset. Comprueba PostgreSQL y el servicio de embeddings.",
        );
      }
    } finally {
      setImportingDemo(false);
    }
  }

  async function handleRetry(document: ProjectDocument) {
    if (!projectId || retryingDocumentId) {
      return;
    }

    setRetryingDocumentId(document.id);
    setOperationError("");
    setOperationNotice("");

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(document.id)}/retry`,
        { method: "POST", cache: "no-store" },
      );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        if (projectIdRef.current === projectId) {
          setOperationError(getFriendlyRequestError(response.status));
        }
        return;
      }

      if (!isRecord(payload) || !isIngestionResponse(payload.data)) {
        throw new Error("La API devolvió un resultado de reintento no válido.");
      }

      if (projectIdRef.current === projectId) {
        if (payload.data.status === "indexed") {
          setOperationNotice(`${document.title}: indexado correctamente.`);
        } else if (payload.data.status === "processing") {
          setOperationNotice(`${document.title}: el reintento sigue procesándose.`);
        } else {
          setOperationError(
            `${document.title}: no quedó indexado (${documentStatusLabels[payload.data.status]}).`,
          );
        }
      }
      await refreshKnowledge(projectId);
    } catch {
      if (projectIdRef.current === projectId) {
        setOperationError("No se pudo reintentar el documento.");
      }
    } finally {
      setRetryingDocumentId("");
    }
  }

  return (
    <main className="knowledge-app">
      <header className="knowledge-topbar">
        <a
          className="workspace-brand"
          href="/"
          aria-label="SentinelOps AI, inicio"
        >
          <span className="workspace-brand-mark" aria-hidden="true">
            S
          </span>
          <span>
            <strong>SENTINELOPS</strong>
            <small>AI INCIDENT INTELLIGENCE</small>
          </span>
        </a>

        <div className="knowledge-breadcrumb">
          <a href="/">Inicio</a>
          <span aria-hidden="true">/</span>
          <span>Knowledge Base</span>
        </div>

        <div className="knowledge-topbar-actions">
          <div className="knowledge-status">
            <ProductApiStatus />
          </div>
          <a href="/investigation">Investigation</a>
        </div>
      </header>

      <div className="knowledge-layout">
        <aside className="knowledge-sidebar" aria-label="Navegación">
          <p>PRODUCTO</p>
          <a className="knowledge-nav-link" href="/">
            <span aria-hidden="true">OV</span>
            Overview
          </a>
          <a
            className="knowledge-nav-link knowledge-nav-link--active"
            href="/knowledge-base"
            aria-current="page"
          >
            <span aria-hidden="true">KB</span>
            Knowledge Base
          </a>
          <a className="knowledge-nav-link" href="/investigation">
            <span aria-hidden="true">IN</span>
            Investigation
          </a>
          <div className="knowledge-sidebar-note">
            Fuentes de solo lectura para búsquedas RAG y análisis de
            incidentes.
          </div>
        </aside>

        <section className="knowledge-content">
          <div className="knowledge-heading">
            <div>
              <p className="workspace-eyebrow">INGESTA E INDEXACIÓN</p>
              <h1>Knowledge Base</h1>
              <p>
                Incorpora documentación técnica, consulta el estado de
                procesamiento y prepara fuentes para investigaciones basadas
                en evidencia.
              </p>
            </div>
            <a className="knowledge-investigation-link" href="/investigation">
              Abrir Investigation
            </a>
          </div>

          <section className="knowledge-project-bar">
            <div>
              <label htmlFor="kb-workspace">Workspace</label>
              <select
                id="kb-workspace"
                value={workspaceId}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  selectProject("");
                  setOperationError("");
                  setOperationNotice("");
                }}
                disabled={loadingWorkspaces || workspaces.length === 0}
              >
                <option value="">
                  {loadingWorkspaces ? "Cargando..." : "Selecciona un workspace"}
                </option>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="kb-project">Proyecto</label>
              <select
                id="kb-project"
                value={projectId}
                onChange={(event) => {
                  selectProject(event.target.value);
                  setOperationError("");
                  setOperationNotice("");
                }}
                disabled={loadingProjects || projects.length === 0}
              >
                <option value="">
                  {loadingProjects ? "Cargando..." : "Selecciona un proyecto"}
                </option>
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                    {project.status === "archived" ? " · archivado" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="knowledge-project-description">
              <span>ALCANCE ACTUAL</span>
              <strong>{selectedProject?.name ?? "Sin proyecto seleccionado"}</strong>
            </div>
          </section>

          {loadingError ? (
            <div className="knowledge-alert knowledge-alert--error" role="alert">
              <span>{loadingError}</span>
              <button
                type="button"
                onClick={() => {
                  setLoadingError("");
                  setWorkspaceId("");
                  window.setTimeout(() => setWorkspaceId(workspaces[0]?.id ?? ""), 0);
                }}
              >
                Reintentar
              </button>
            </div>
          ) : null}

          {!loadingWorkspaces && workspaces.length === 0 && !loadingError ? (
            <div className="knowledge-alert">
              No hay workspaces disponibles en la API de producto.
            </div>
          ) : null}

          <section className="knowledge-metrics" aria-label="Estado del proyecto">
            <div>
              <span>FUENTES</span>
              <strong>{sources.length}</strong>
              <small>registradas en el proyecto</small>
            </div>
            <div>
              <span>DOCUMENTOS INDEXADOS</span>
              <strong>{indexedCount}</strong>
              <small>disponibles para recuperación</small>
            </div>
            <div>
              <span>EN PROCESAMIENTO</span>
              <strong>{processingCount}</strong>
              <small>ingestas activas</small>
            </div>
            <div>
              <span>CON ERRORES</span>
              <strong>{failedCount}</strong>
              <small>requieren revisión o reintento</small>
            </div>
          </section>

          <section className="knowledge-ingestion-grid">
            <article className="knowledge-panel upload-panel">
              <div className="knowledge-panel-heading">
                <div>
                  <p>FUENTES TÉCNICAS</p>
                  <h2>Cargar archivos</h2>
                </div>
                <span className="knowledge-panel-icon" aria-hidden="true">
                  UP
                </span>
              </div>

              <p className="knowledge-panel-description">
                Se calcula SHA-256 en el servidor, se extrae texto UTF-8 y se
                fragmenta según el formato. El contenido se usa como datos,
                nunca se ejecuta.
              </p>

              <form className="knowledge-upload-form" onSubmit={handleUpload}>
                <label htmlFor="knowledge-files">Seleccionar archivos</label>
                <input
                  ref={fileInput}
                  id="knowledge-files"
                  type="file"
                  multiple
                  disabled={!projectId || uploading || importingDemo}
                  onChange={handleFileSelection}
                  accept=".bash,.c,.cc,.cpp,.cs,.css,.csv,.go,.graphql,.h,.hpp,.html,.ini,.java,.js,.json,.jsonl,.jsx,.kt,.log,.md,.php,.proto,.ps1,.py,.rb,.rs,.rst,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.tsv,.xml,.yaml,.yml,.dockerignore,.editorconfig,.gitignore"
                />
                <p className="knowledge-file-hint">{ACCEPTED_FILE_HINT}</p>
                {selectedFiles.length > 0 ? (
                  <ul className="selected-file-list">
                    {selectedFiles.map((file) => (
                      <li key={`${file.name}-${file.lastModified}`}>
                        <span>{file.name}</span>
                        <small>{(file.size / 1024).toFixed(1)} KB</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <button
                  className="knowledge-primary-button"
                  type="submit"
                  disabled={
                    !projectId ||
                    selectedFiles.length === 0 ||
                    uploading ||
                    importingDemo
                  }
                >
                  {uploading ? "Procesando archivos..." : "Cargar e indexar"}
                </button>
                {uploadProgress ? (
                  <p className="knowledge-operation-status" role="status">
                    <span className="knowledge-spinner" aria-hidden="true" />
                    {uploadProgress}
                  </p>
                ) : null}
              </form>

              <div className="knowledge-divider">
                <span>o importa una fuente de demostración</span>
              </div>

              <button
                className="knowledge-demo-button"
                type="button"
                onClick={() => void handleDemoImport()}
                disabled={!projectId || uploading || importingDemo}
              >
                {importingDemo ? (
                  <>
                    <span className="knowledge-spinner" aria-hidden="true" />
                    Indexando dataset...
                  </>
                ) : (
                  "Importar dataset sintético INC-001"
                )}
              </button>
              <p className="knowledge-demo-note">
                Importa únicamente logs y código sintéticos de demostración.
                Excluye la carpeta ground-truth; no se ejecuta el código.
              </p>
            </article>

            <article className="knowledge-panel source-panel">
              <div className="knowledge-panel-heading">
                <div>
                  <p>ORÍGENES DEL CONOCIMIENTO</p>
                  <h2>Fuentes registradas</h2>
                </div>
                <span className="knowledge-panel-count">{sources.length}</span>
              </div>

              {!projectId ? (
                <div className="knowledge-empty">
                  Selecciona un proyecto para consultar sus fuentes.
                </div>
              ) : sources.length === 0 && !loadingKnowledge ? (
                <div className="knowledge-empty">
                  Este proyecto todavía no tiene fuentes registradas.
                </div>
              ) : (
                <div className="knowledge-source-list">
                  {sources.map((source) => (
                    <div className="knowledge-source-row" key={source.id}>
                      <span className="source-type-icon" aria-hidden="true">
                        {source.sourceType === "log_bundle" ? "LG" : "FS"}
                      </span>
                      <div className="knowledge-source-copy">
                        <strong>{source.name}</strong>
                        <span>{sourceTypeLabels[source.sourceType]}</span>
                        <small title={source.locator}>{source.locator}</small>
                      </div>
                      <span
                        className={`source-status source-status--${source.status}`}
                      >
                        {sourceStatusLabels[source.status]}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>

          {operationError ? (
            <div className="knowledge-alert knowledge-alert--error" role="alert">
              {operationError}
            </div>
          ) : null}
          {operationNotice ? (
            <div className="knowledge-alert knowledge-alert--success" role="status">
              {operationNotice}
            </div>
          ) : null}

          <section className="knowledge-panel document-panel">
            <div className="knowledge-panel-heading">
              <div>
                <p>INDEXACIÓN Y PROCESAMIENTO</p>
                <h2>Documentos</h2>
              </div>
              <span className="knowledge-panel-count">{documents.length}</span>
            </div>

            {!projectId ? (
              <div className="knowledge-empty">
                Selecciona un proyecto para consultar sus documentos.
              </div>
            ) : loadingKnowledge && documents.length === 0 ? (
              <div className="knowledge-empty">
                Cargando documentos del proyecto...
              </div>
            ) : documents.length === 0 ? (
              <div className="knowledge-empty">
                No hay documentos todavía. Carga archivos o importa el dataset
                de demostración para iniciar el pipeline.
              </div>
            ) : (
              <div className="knowledge-document-list">
                {documents.map((document) => {
                  const ingestion = getIngestionMetadata(document);
                  const isSynthetic =
                    document.metadata.synthetic === true ||
                    ingestion.synthetic === true;
                  const error =
                    typeof ingestion.error === "string"
                      ? humanizeIngestionError(ingestion.error)
                      : "";
                  const attempts =
                    typeof ingestion.attempts === "number"
                      ? ingestion.attempts
                      : 0;

                  return (
                    <article
                      className="knowledge-document-row"
                      key={document.id}
                    >
                      <span
                        className={`document-file-icon ${
                          isSynthetic ? "document-file-icon--synthetic" : ""
                        }`}
                        aria-hidden="true"
                      >
                        {document.title.split(".").pop()?.toUpperCase() ?? "DOC"}
                      </span>
                      <div className="knowledge-document-copy">
                        <div className="knowledge-document-title">
                          <strong>{document.title}</strong>
                          {isSynthetic ? (
                            <span className="synthetic-document-badge">
                              SINTÉTICO
                            </span>
                          ) : null}
                        </div>
                        <span>
                          {document.mediaType ?? "Tipo no especificado"}
                          {document.contentSha256
                            ? ` · SHA-256 ${document.contentSha256.slice(0, 12)}…`
                            : ""}
                        </span>
                        {error ? (
                          <small className="document-processing-error">
                            {error}
                          </small>
                        ) : (
                          <small>
                            {attempts > 0 ? `Intentos: ${attempts}` : " "}
                            {typeof ingestion.embeddingModel === "string"
                              ? ` · Embeddings: ${ingestion.embeddingModel}`
                              : ""}
                          </small>
                        )}
                      </div>
                      <span
                        className={`document-status document-status--${document.status}`}
                      >
                        {document.status === "processing" ? (
                          <span className="knowledge-spinner" aria-hidden="true" />
                        ) : null}
                        {documentStatusLabels[document.status]}
                      </span>
                      {document.status === "failed" ||
                      document.status === "discovered" ? (
                        <button
                          className="document-retry-button"
                          type="button"
                          onClick={() => void handleRetry(document)}
                          disabled={retryingDocumentId === document.id}
                        >
                          {retryingDocumentId === document.id
                            ? "Reintentando..."
                            : "Reintentar"}
                        </button>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <footer className="knowledge-footer">
            <span>
              El contenido indexado puede recuperarse desde Investigation.
            </span>
            <a href="/investigation">Abrir Investigation Workspace →</a>
          </footer>
        </section>
      </div>
    </main>
  );
}
