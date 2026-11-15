export type QaImportance = "info" | "warning" | "high";

export interface QaFinding {
  id: string;
  ruleId: string;
  ruleVersion: string;
  category: "configuration" | "quality" | "security" | "testing";
  importance: QaImportance;
  title: string;
  description: string;
  whyItMatters: string;
  recommendation: string;
  verificationStatus: "verified_static";
  evidence: {
    filePath: string;
    startLine: number;
    endLine: number;
    excerpt: string;
    contentSha256: string;
  };
}

export interface QaAnalysisReport {
  analysisId: string;
  rulesetVersion: string;
  repositoryUrl: string;
  revision: string;
  detectedStack: string[];
  inventory: QaInventory;
  inspectedFiles: Array<{
    path: string;
    contentSha256: string;
    byteLength: number;
  }>;
  checksPerformed: string[];
  findings: QaFinding[];
  limitations: string[];
  testExecution: {
    status: "not_executed";
    reason: string;
  };
}

export interface QaInventory {
  selectionStrategy: "category_priority_v1";
  discoveredFiles: number;
  selectedFiles: number;
  categories: Array<{
    category: "manifest" | "test_configuration" | "source" | "test" | "documentation" | "other";
    discovered: number;
    selected: number;
  }>;
  testFiles: {
    discovered: number;
    selected: number;
  };
}

export interface QaImportResult {
  source: {
    id: string;
    created: boolean;
    status: "active";
  };
  repository: {
    url: string;
    owner: string;
    name: string;
    defaultBranch: string;
    revision: string;
    inspectedFileCount: number;
    inventory: QaInventory;
    skipped: {
      unsupported: number;
      tooLarge: number;
      invalidPath: number;
      limitReached: number;
    };
  };
  analysis: QaAnalysisReport;
}

const findingCategories = ["configuration", "quality", "security", "testing"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFinding(value: unknown): value is QaFinding {
  if (!isRecord(value) || !isRecord(value.evidence)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.ruleId === "string" &&
    typeof value.ruleVersion === "string" &&
    findingCategories.includes(value.category as typeof findingCategories[number]) &&
    ["info", "warning", "high"].includes(value.importance as QaImportance) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.whyItMatters === "string" &&
    typeof value.recommendation === "string" &&
    value.verificationStatus === "verified_static" &&
    typeof value.evidence.filePath === "string" &&
    typeof value.evidence.startLine === "number" &&
    typeof value.evidence.endLine === "number" &&
    typeof value.evidence.excerpt === "string" &&
    typeof value.evidence.contentSha256 === "string"
  );
}

function isSkippedInventory(value: unknown): value is QaImportResult["repository"]["skipped"] {
  return (
    isRecord(value) &&
    ["unsupported", "tooLarge", "invalidPath", "limitReached"].every(
      (key) => typeof value[key] === "number",
    )
  );
}

const inventoryCategories = ["manifest", "test_configuration", "source", "test", "documentation", "other"] as const;

function isInventory(value: unknown): value is QaInventory {
  return (
    isRecord(value) &&
    value.selectionStrategy === "category_priority_v1" &&
    typeof value.discoveredFiles === "number" &&
    typeof value.selectedFiles === "number" &&
    Array.isArray(value.categories) &&
    value.categories.length === inventoryCategories.length &&
    value.categories.every((item) =>
      isRecord(item) &&
      inventoryCategories.includes(item.category as typeof inventoryCategories[number]) &&
      typeof item.discovered === "number" &&
      typeof item.selected === "number",
    ) &&
    isRecord(value.testFiles) &&
    typeof value.testFiles.discovered === "number" &&
    typeof value.testFiles.selected === "number"
  );
}

export function isQaImportResult(value: unknown): value is QaImportResult {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.repository) || !isRecord(value.analysis)) {
    return false;
  }
  const { source, repository, analysis } = value;
  return (
    typeof source.id === "string" &&
    typeof source.created === "boolean" &&
    source.status === "active" &&
    typeof repository.url === "string" &&
    typeof repository.owner === "string" &&
    typeof repository.name === "string" &&
    typeof repository.defaultBranch === "string" &&
    typeof repository.revision === "string" &&
    typeof repository.inspectedFileCount === "number" &&
    isInventory(repository.inventory) &&
    isSkippedInventory(repository.skipped) &&
    typeof analysis.analysisId === "string" &&
    typeof analysis.rulesetVersion === "string" &&
    typeof analysis.repositoryUrl === "string" &&
    typeof analysis.revision === "string" &&
    isStringArray(analysis.detectedStack) &&
    isInventory(analysis.inventory) &&
    Array.isArray(analysis.inspectedFiles) &&
    analysis.inspectedFiles.every((file) =>
      isRecord(file) &&
      typeof file.path === "string" &&
      typeof file.contentSha256 === "string" &&
      typeof file.byteLength === "number",
    ) &&
    isStringArray(analysis.checksPerformed) &&
    Array.isArray(analysis.findings) && analysis.findings.every(isFinding) &&
    isStringArray(analysis.limitations) &&
    isRecord(analysis.testExecution) &&
    analysis.testExecution.status === "not_executed" &&
    typeof analysis.testExecution.reason === "string"
  );
}

function normalizeQuestion(question: string): string {
  return question
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-CO");
}

function findingsForQuestion(question: string, report: QaAnalysisReport): QaFinding[] {
  const normalized = normalizeQuestion(question);
  if (/seguridad|clave|secreto|eval/u.test(normalized)) {
    return report.findings.filter((finding) => finding.category === "security");
  }
  if (/prueba|test|ejecut/u.test(normalized)) {
    return report.findings.filter((finding) => finding.category === "testing");
  }
  if (/configuracion|config|lint|script/u.test(normalized)) {
    return report.findings.filter((finding) => finding.category === "configuration");
  }
  return report.findings;
}

/** Returns a deterministic explanation over this browser session's attested static report. */
export function answerQaQuestion(question: string, report: QaAnalysisReport): string {
  const normalized = normalizeQuestion(question);
  const findings = findingsForQuestion(question, report);

  if (/prueba|test|ejecut/u.test(normalized)) {
    return `Estado de ejecución: no ejecutado. ${report.testExecution.reason}`;
  }
  if (/donde|archivo|linea|evidencia|ocurre/u.test(normalized)) {
    if (findings.length === 0) {
      return "No hay hallazgos de esa categoría con una ubicación verificable en el informe actual.";
    }
    return findings.slice(0, 5).map((finding) =>
      `${finding.title}: ${finding.evidence.filePath}, línea ${finding.evidence.startLine}.`,
    ).join(" ");
  }
  if (/correg|recomend|hacer/u.test(normalized)) {
    if (findings.length === 0) {
      return "No hay una recomendación específica para esa categoría porque las comprobaciones ejecutadas no produjeron hallazgos asociados.";
    }
    return findings.slice(0, 4).map((finding) => finding.recommendation).join(" ");
  }
  if (/encontr|resumen|hallazgo|importan/u.test(normalized)) {
    if (findings.length === 0) {
      return "No se encontraron problemas mediante las comprobaciones estáticas ejecutadas. Esto no demuestra que el proyecto esté libre de defectos o vulnerabilidades.";
    }
    const high = findings.filter((finding) => finding.importance === "high").length;
    return `El análisis encontró ${findings.length} ${findings.length === 1 ? "hallazgo" : "hallazgos"} verificables${high > 0 ? `, incluidos ${high} de importancia alta` : ""}. Cada uno conserva archivo, línea y evidencia consultable.`;
  }
  return "Puedo explicar los hallazgos, sus ubicaciones, las recomendaciones o qué pruebas no se ejecutaron. Esta conversación no genera conclusiones fuera del informe estático actual.";
}

export function importanceLabel(importance: QaImportance): string {
  return {
    high: "Alta",
    warning: "Revisar",
    info: "Informativo",
  }[importance];
}
