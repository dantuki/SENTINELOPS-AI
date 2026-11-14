import { createHash } from "node:crypto";

export const QA_RULESET_VERSION = "qa-static-v1";

export type QaFindingCategory =
  | "configuration"
  | "quality"
  | "security"
  | "testing";

export type QaFindingImportance = "info" | "warning" | "high";

export interface QaSourceFile {
  path: string;
  content: string;
  contentSha256: string;
  byteLength: number;
}

export interface QaFindingEvidence {
  filePath: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  contentSha256: string;
}

export interface QaFinding {
  id: string;
  ruleId: string;
  ruleVersion: string;
  category: QaFindingCategory;
  importance: QaFindingImportance;
  title: string;
  description: string;
  whyItMatters: string;
  recommendation: string;
  verificationStatus: "verified_static";
  evidence: QaFindingEvidence;
}

export interface QaAnalysisInput {
  repositoryUrl: string;
  revision: string;
  files: QaSourceFile[];
}

export interface QaAnalysisReport {
  analysisId: string;
  rulesetVersion: string;
  repositoryUrl: string;
  revision: string;
  detectedStack: string[];
  inspectedFiles: Array<Pick<QaSourceFile, "path" | "contentSha256" | "byteLength">>;
  checksPerformed: string[];
  findings: QaFinding[];
  limitations: string[];
  testExecution: {
    status: "not_executed";
    reason: string;
  };
}

const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const EVAL_CALL = /\beval\s*\(/u;
const SENSITIVE_ASSIGNMENT = /\b(?:api[_-]?key|password|secret|token)\b\s*[:=]\s*(["'`])[^"'`\r\n]+\1/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gu;
const TEST_FILE = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.(?:[cm]?[jt]sx?|py)$/iu;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineFor(content: string, expression: RegExp): number | null {
  const match = expression.exec(content);
  if (!match || match.index === undefined) return null;
  return content.slice(0, match.index).split(/\r?\n/u).length;
}

function lineText(content: string, line: number): string {
  return content.split(/\r?\n/u)[line - 1] ?? "";
}

function redactExcerpt(value: string): string {
  const redacted = value
    .replace(PRIVATE_KEY_MARKER, "-----BEGIN … PRIVATE KEY----- [redactado]")
    .replace(SENSITIVE_ASSIGNMENT, (match) => {
      const separator = match.includes(":") ? ":" : "=";
      const name = match.slice(0, match.indexOf(separator)).trim();
      return `${name}${separator} [redactado]`;
    })
    .replace(BEARER_TOKEN, "Bearer [redactado]");

  return redacted.length > 240 ? `${redacted.slice(0, 237)}…` : redacted;
}

function finding(input: Omit<QaFinding, "id" | "ruleVersion" | "verificationStatus">): QaFinding {
  const identity = [
    input.ruleId,
    input.evidence.filePath,
    input.evidence.startLine,
    input.evidence.contentSha256,
  ].join(":");

  return {
    ...input,
    id: `qa-${hash(identity).slice(0, 20)}`,
    ruleVersion: QA_RULESET_VERSION,
    verificationStatus: "verified_static",
  };
}

function evidenceFor(file: QaSourceFile, line: number): QaFindingEvidence {
  return {
    filePath: file.path,
    startLine: line,
    endLine: line,
    excerpt: redactExcerpt(lineText(file.content, line)),
    contentSha256: file.contentSha256,
  };
}

function detectStack(files: readonly QaSourceFile[]): string[] {
  const paths = new Set(files.map((file) => file.path.toLowerCase()));
  const stacks: string[] = [];
  if (paths.has("package.json")) stacks.push("Node.js");
  if ([...paths].some((path) => /\.(?:ts|tsx)$/u.test(path))) stacks.push("TypeScript");
  if (paths.has("next.config.ts") || paths.has("next.config.js") || paths.has("next.config.mjs")) {
    stacks.push("Next.js");
  }
  if ([...paths].some((path) => /\.(?:jsx|tsx)$/u.test(path))) stacks.push("React");
  if ([...paths].some((path) => /\.py$/u.test(path))) stacks.push("Python");
  return stacks;
}

function hasDeclaredScript(value: unknown, scriptName: string): boolean {
  if (typeof value !== "object" || value === null || !("scripts" in value)) return false;
  const scripts = (value as Record<string, unknown>)["scripts"];
  return (
    typeof scripts === "object" &&
    scripts !== null &&
    scriptName in scripts &&
    typeof (scripts as Record<string, unknown>)[scriptName] === "string" &&
    (scripts as Record<string, string>)[scriptName].trim().length > 0
  );
}

/**
 * Applies a small, deterministic rule set to already downloaded text files.
 * It intentionally never executes imported code or presents a global quality score.
 */
export function analyzeQaProject(input: QaAnalysisInput): QaAnalysisReport {
  const files = [...input.files].sort((left, right) => comparePaths(left.path, right.path));
  const findings: QaFinding[] = [];
  const checksPerformed = [
    "Inventario de archivos de texto soportados",
    "Detección de stack mediante manifiestos y extensiones",
    "Configuración declarada de pruebas y lint",
    "Patrones estáticos de claves privadas y ejecución dinámica",
  ];
  const packageFile = files.find((file) => file.path === "package.json");

  if (packageFile) {
    try {
      const manifest: unknown = JSON.parse(packageFile.content);
      if (!hasDeclaredScript(manifest, "test")) {
        findings.push(finding({
          ruleId: "qa.testing.missing_test_script",
          category: "testing",
          importance: "info",
          title: "No hay script de pruebas declarado",
          description: "El manifiesto package.json no declara un script npm llamado test.",
          whyItMatters: "No permite concluir que no existan pruebas, pero dificulta ejecutar una comprobación estándar de forma explícita.",
          recommendation: "Declara el comando de pruebas verificable en scripts.test cuando el proyecto lo soporte.",
          evidence: evidenceFor(packageFile, lineFor(packageFile.content, /"scripts"\s*:/u) ?? 1),
        }));
      }
      if (!hasDeclaredScript(manifest, "lint")) {
        findings.push(finding({
          ruleId: "qa.configuration.missing_lint_script",
          category: "configuration",
          importance: "info",
          title: "No hay script de lint declarado",
          description: "El manifiesto package.json no declara un script npm llamado lint.",
          whyItMatters: "El análisis no ejecutó herramientas externas; un script declarado haría verificable la política de lint del proyecto.",
          recommendation: "Declara scripts.lint si el proyecto tiene una herramienta de lint configurada.",
          evidence: evidenceFor(packageFile, lineFor(packageFile.content, /"scripts"\s*:/u) ?? 1),
        }));
      }
    } catch {
      findings.push(finding({
        ruleId: "qa.configuration.invalid_package_json",
        category: "configuration",
        importance: "warning",
        title: "package.json no es JSON válido",
        description: "El manifiesto encontrado no pudo interpretarse como JSON estricto.",
        whyItMatters: "Las herramientas Node.js dependen de un manifiesto válido para interpretar scripts y dependencias declaradas.",
        recommendation: "Corrige la sintaxis JSON y vuelve a ejecutar el análisis.",
        evidence: evidenceFor(packageFile, 1),
      }));
    }
  }

  const nodeProject = packageFile !== undefined || files.some((file) => /\.[cm]?[jt]sx?$/u.test(file.path));
  if (nodeProject && !files.some((file) => TEST_FILE.test(file.path))) {
    const evidence = packageFile ?? files[0];
    if (evidence) {
      findings.push(finding({
        ruleId: "qa.testing.no_discovered_test_files",
        category: "testing",
        importance: "info",
        title: "No se encontraron archivos de prueba en el inventario analizado",
        description: "No se detectaron nombres de archivo con las convenciones .test o .spec dentro de los archivos inspeccionados.",
        whyItMatters: "Esta comprobación está limitada al inventario soportado; no demuestra que el proyecto no tenga pruebas en otra herramienta o ruta omitida.",
        recommendation: "Revisa la ubicación y la convención de las pruebas, y decláralas mediante un script de pruebas cuando corresponda.",
        evidence: evidenceFor(evidence, 1),
      }));
    }
  }

  for (const file of files) {
    const keyLine = lineFor(file.content, PRIVATE_KEY_MARKER);
    if (keyLine !== null) {
      findings.push(finding({
        ruleId: "qa.security.private_key_material",
        category: "security",
        importance: "high",
        title: "Se detectó un marcador de clave privada",
        description: "El archivo contiene un encabezado PEM de clave privada. La evidencia se ha redactado para no exponer el material sensible.",
        whyItMatters: "Una clave privada versionada puede permitir acceso no autorizado si sigue siendo válida o se distribuyó fuera del control esperado.",
        recommendation: "Revoca y rota la clave si es real, elimínala del repositorio y usa un gestor de secretos adecuado.",
        evidence: evidenceFor(file, keyLine),
      }));
    }

    const evalLine = lineFor(file.content, EVAL_CALL);
    if (evalLine !== null) {
      findings.push(finding({
        ruleId: "qa.security.dynamic_eval",
        category: "security",
        importance: "warning",
        title: "Se detectó una llamada a eval",
        description: "El análisis estático encontró una llamada a eval en el archivo indicado.",
        whyItMatters: "La ejecución dinámica puede amplificar el riesgo si recibe datos no confiables; este hallazgo no demuestra que exista una ruta explotable.",
        recommendation: "Sustituye eval por una alternativa con datos y operaciones permitidas explícitamente, o documenta el aislamiento aplicable.",
        evidence: evidenceFor(file, evalLine),
      }));
    }
  }

  const analysisIdentity = [
    QA_RULESET_VERSION,
    input.repositoryUrl,
    input.revision,
    ...files.map((file) => `${file.path}:${file.contentSha256}`),
  ].join("\n");

  return {
    analysisId: `qa-${hash(analysisIdentity).slice(0, 24)}`,
    rulesetVersion: QA_RULESET_VERSION,
    repositoryUrl: input.repositoryUrl,
    revision: input.revision,
    detectedStack: detectStack(files),
    inspectedFiles: files.map(({ path, contentSha256, byteLength }) => ({
      path,
      contentSha256,
      byteLength,
    })),
    checksPerformed,
    findings,
    limitations: [
      "El análisis inspecciona únicamente archivos de texto soportados y no ejecuta instalaciones, builds, linters ni pruebas del repositorio.",
      "La ausencia de un hallazgo en estas reglas no demuestra que el proyecto esté libre de defectos o vulnerabilidades.",
    ],
    testExecution: {
      status: "not_executed",
      reason: "No se ejecuta código de repositorios importados sin un worker aislado y verificado.",
    },
  };
}
