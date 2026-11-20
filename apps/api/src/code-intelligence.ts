import { createHash } from "node:crypto";
import ts from "typescript-compiler-api";

export const QA_CODE_INTELLIGENCE_VERSION = "qa-code-intelligence-v2";

export type QaMetricPrecision = "exact_under_model" | "approximate" | "unknown" | "not_applicable";
export type QaCodeLanguage = "javascript" | "typescript" | "python";
export type QaCodeFileStatus = "parsed" | "syntax_error" | "unavailable";

export interface CodeIntelligenceSourceFile {
  path: string;
  content: string;
  contentSha256: string;
  byteLength: number;
}

export interface QaCodeSymbol {
  id: string;
  name: string;
  qualifiedName?: string;
  kind: "class" | "function" | "async_function" | "interface" | "method" | "type" | "variable";
  exported: boolean;
  startLine: number;
  endLine: number;
  parameterCount: number | null;
  decoratorCount?: number;
  cyclomaticComplexity?: number | null;
}

export type QaRelationResolution = "resolved" | "partially_resolved" | "unresolved";

export interface QaCodeRelation {
  kind: "calls" | "declares" | "exports" | "extends" | "implements" | "imports" | "from_imports";
  from: string;
  to: string;
  startLine: number;
  /**
   * A direct syntax relation may be resolved inside this parsed source unit.
   * Imports name a module but do not resolve it through the host filesystem.
   */
  resolved: boolean;
  resolution: QaRelationResolution;
  callSafety?: {
    shellTrue: boolean;
    commandIsConstant: boolean;
  };
}

/** Counts under the documented syntax model; absent for historic JS/TS reports. */
export interface QaConstructCounts {
  if: number;
  for: number;
  asyncFor: number;
  while: number;
  try: number;
  except: number;
  with: number;
  asyncWith: number;
  return: number;
  raise: number;
  lambda: number;
  decorator: number;
}

export interface QaCodeFileMetrics {
  path: string;
  contentSha256: string;
  language: QaCodeLanguage;
  status: QaCodeFileStatus;
  physicalLines: number;
  codeLines: number | null;
  cyclomaticComplexity: number | null;
  maxNesting: number | null;
  metricPrecision: {
    physicalLines: QaMetricPrecision;
    codeLines: QaMetricPrecision;
    cyclomaticComplexity: QaMetricPrecision;
    maxNesting: QaMetricPrecision;
  };
  parseDiagnostics: number;
  constructCounts?: QaConstructCounts;
  symbols: QaCodeSymbol[];
  relations: QaCodeRelation[];
  truncated: boolean;
}

/** The validated, body-free structural response returned by the Python service. */
export interface QaPythonAstFileMetrics extends Omit<QaCodeFileMetrics, "language" | "symbols"> {
  language: "python";
  symbols: Array<Omit<QaCodeSymbol, "exported">>;
}

export interface QaReadmeFacts {
  path: string;
  contentSha256: string;
  headings: string[];
  mentionsTests: boolean;
  mentionsInstall: boolean;
  claims: QaDocumentationClaim[];
  truncated: boolean;
}

export interface QaDocumentationClaim {
  id: string;
  kind: "test_script" | "technology" | "file_reference";
  documentedValue: string;
  readmeLine: number;
  status: "documented" | "observed_in_code" | "corroborated" | "contradicted" | "unverified";
  observedPath?: string;
}

export interface QaManifestFacts {
  path: string;
  contentSha256: string;
  status: "valid" | "invalid";
  scripts: string[];
  dependencyCount: number;
  developmentDependencyCount: number;
}

export interface QaCodeIntelligenceReport {
  version: typeof QA_CODE_INTELLIGENCE_VERSION;
  analyzedFiles: QaCodeFileMetrics[];
  readmes: QaReadmeFacts[];
  manifests: QaManifestFacts[];
  summary: {
    analyzedFileCount: number;
    parsedFileCount: number;
    symbolCount: number;
    relationCount: number;
    languageCounts: { javascript: number; typescript: number; python: number; unsupported: number };
    parseDiagnosticCount: number;
    unavailablePythonFileCount: number;
  };
  limitations: string[];
}

export interface QaCodeLocation {
  filePath: string;
  startLine: number;
  endLine: number;
}

const MAX_SYMBOLS_PER_FILE = 128;
const MAX_RELATIONS_PER_FILE = 256;
const MAX_DOCUMENTATION_HEADINGS = 32;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scriptKindForPath(path: string): ts.ScriptKind | null {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (normalized.endsWith(".ts") || normalized.endsWith(".mts") || normalized.endsWith(".cts")) return ts.ScriptKind.TS;
  if (normalized.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) return ts.ScriptKind.JS;
  return null;
}

function languageForPath(path: string): "javascript" | "typescript" | null {
  const kind = scriptKindForPath(path);
  if (kind === null) return null;
  return [ts.ScriptKind.TS, ts.ScriptKind.TSX].includes(kind) ? "typescript" : "javascript";
}

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function nameFor(node: ts.NamedDeclaration): string | null {
  const name = node.name;
  if (!name || !ts.isIdentifier(name)) return null;
  return name.text;
}

function exported(node: ts.Node): boolean {
  const modifiers = (node as ts.Node & {
    modifiers?: ReadonlyArray<{ kind: ts.SyntaxKind }>;
  }).modifiers;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function addSymbol(
  symbols: QaCodeSymbol[],
  source: ts.SourceFile,
  file: CodeIntelligenceSourceFile,
  node: ts.NamedDeclaration,
  kind: QaCodeSymbol["kind"],
  parameterCount: number | null = null,
  cyclomaticComplexity: number | null = null,
): boolean {
  if (symbols.length >= MAX_SYMBOLS_PER_FILE) return false;
  const name = nameFor(node);
  if (!name) return true;
  const startLine = lineAt(source, node.getStart(source));
  const endLine = lineAt(source, node.getEnd());
  symbols.push({
    id: `symbol-${hash(`${file.path}:${file.contentSha256}:${kind}:${name}:${startLine}`).slice(0, 20)}`,
    name,
    kind,
    exported: exported(node),
    startLine,
    endLine,
    parameterCount,
    cyclomaticComplexity,
  });
  return true;
}

function expressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function countCodeLines(source: ts.SourceFile): number {
  const lines = new Set<number>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, source.languageVariant, source.text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    lines.add(source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1);
  }
  return lines.size;
}

function isComplexityDecision(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) ||
    ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
    ts.isConditionalExpression(node) || ts.isCatchClause(node) || ts.isCaseClause(node)
  );
}

/**
 * McCabe-style complexity under the documented syntax model: base path 1 plus
 * decisions (control branches and short-circuit boolean operators). Nested
 * declarations are deliberately excluded from their containing function.
 */
function complexityForFunction(node: ts.FunctionLikeDeclaration): number {
  let complexity = 1;
  const visit = (current: ts.Node): void => {
    if (current !== node && (
      ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) || ts.isMethodDeclaration(current)
    )) return;
    if (isComplexityDecision(current)) complexity += 1;
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) complexity += 1;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return complexity;
}

function analyzeTypeScriptFile(file: CodeIntelligenceSourceFile): QaCodeFileMetrics {
  const scriptKind = scriptKindForPath(file.path);
  const language = languageForPath(file.path);
  if (scriptKind === null || language === null) throw new Error("Unsupported source file passed to TypeScript analyzer");
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols: QaCodeSymbol[] = [];
  const relations: QaCodeRelation[] = [];
  let complexity = 1;
  let nesting = 0;
  let maximumNesting = 0;
  let truncated = false;

  const addRelation = (
    kind: QaCodeRelation["kind"],
    from: string,
    to: string,
    node: ts.Node,
    resolution: QaRelationResolution = "unresolved",
  ): void => {
    if (relations.length >= MAX_RELATIONS_PER_FILE) {
      truncated = true;
      return;
    }
    relations.push({
      kind,
      from,
      to,
      startLine: lineAt(source, node.getStart(source)),
      resolved: resolution === "resolved",
      resolution,
    });
  };

  const declare = (node: ts.NamedDeclaration, owner: string): void => {
    const name = nameFor(node);
    if (!name) return;
    addRelation("declares", owner, name, node, "resolved");
    if (exported(node)) addRelation("exports", "<module>", name, node, "resolved");
  };

  const visit = (node: ts.Node, owner = "<module>"): void => {
    let nested = false;
    if (
      ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) ||
      ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
      ts.isConditionalExpression(node) || ts.isCatchClause(node) || ts.isCaseClause(node)
    ) {
      complexity += 1;
      nesting += 1;
      maximumNesting = Math.max(maximumNesting, nesting);
      nested = true;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      complexity += 1;
    }

    let nextOwner = owner;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if (!addSymbol(symbols, source, file, node, "function", node.parameters.length, complexityForFunction(node))) truncated = true;
      declare(node, owner);
      nextOwner = nameFor(node) ?? owner;
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      if (!addSymbol(symbols, source, file, node, "method", node.parameters.length, ts.isMethodDeclaration(node) ? complexityForFunction(node) : null)) truncated = true;
      declare(node, owner);
      nextOwner = nameFor(node) ?? owner;
    } else if (ts.isClassDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "class")) truncated = true;
      declare(node, owner);
      nextOwner = nameFor(node) ?? owner;
    } else if (ts.isInterfaceDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "interface")) truncated = true;
      declare(node, owner);
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "type")) truncated = true;
      declare(node, owner);
    } else if (ts.isVariableDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "variable")) truncated = true;
      declare(node, owner);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addRelation("imports", owner, node.moduleSpecifier.text, node, "partially_resolved");
    } else if (ts.isCallExpression(node)) {
      const target = expressionName(node.expression);
      if (target) addRelation("calls", owner, target, node);
    } else if (ts.isHeritageClause(node)) {
      const kind = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of node.types) addRelation(kind, owner, type.expression.getText(source).slice(0, 200), type, "partially_resolved");
    }

    ts.forEachChild(node, (child) => visit(child, nextOwner));
    if (nested) nesting -= 1;
  };

  visit(source);
  return {
    path: file.path,
    contentSha256: file.contentSha256,
    language,
    status: "parsed",
    physicalLines: file.content === "" ? 0 : file.content.split(/\r?\n/u).length,
    codeLines: countCodeLines(source),
    cyclomaticComplexity: complexity,
    maxNesting: maximumNesting,
    metricPrecision: {
      physicalLines: "exact_under_model",
      codeLines: "exact_under_model",
      cyclomaticComplexity: "exact_under_model",
      maxNesting: "exact_under_model",
    },
    parseDiagnostics: (
      source as unknown as { parseDiagnostics?: readonly unknown[] }
    ).parseDiagnostics?.length ?? 0,
    symbols,
    relations,
    truncated,
  };
}

function analyzeReadme(file: CodeIntelligenceSourceFile): QaReadmeFacts {
  const claims: QaDocumentationClaim[] = [];
  const addClaim = (
    kind: QaDocumentationClaim["kind"],
    documentedValue: string,
    readmeLine: number,
  ): void => {
    if (claims.length >= MAX_DOCUMENTATION_HEADINGS * 2) return;
    if (claims.some((claim) => claim.kind === kind && claim.documentedValue === documentedValue)) return;
    claims.push({
      id: `doc-${hash(`${file.path}:${kind}:${documentedValue}:${readmeLine}`).slice(0, 20)}`,
      kind,
      documentedValue,
      readmeLine,
      status: "documented",
    });
  };
  for (const [index, line] of file.content.split(/\r?\n/u).entries()) {
    if (/\bnpm\s+(?:run\s+)?test\b/iu.test(line)) addClaim("test_script", "test", index + 1);
    for (const technology of ["TypeScript", "JavaScript", "Node.js", "Python"] as const) {
      if (line.includes(technology)) addClaim("technology", technology, index + 1);
    }
    for (const match of line.matchAll(/`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/gu)) {
      const reference = match[1];
      if (reference) addClaim("file_reference", reference, index + 1);
    }
  }
  const headings = file.content
    .split(/\r?\n/u)
    .map((line) => /^#{1,6}\s+(.{1,200})$/u.exec(line.trim())?.[1]?.trim() ?? null)
    .filter((line): line is string => line !== null);
  return {
    path: file.path,
    contentSha256: file.contentSha256,
    headings: headings.slice(0, MAX_DOCUMENTATION_HEADINGS),
    mentionsTests: /\b(?:test|tests|pruebas?)\b/iu.test(file.content),
    mentionsInstall: /\b(?:install|instalaci[oó]n|setup)\b/iu.test(file.content),
    claims,
    truncated: headings.length > MAX_DOCUMENTATION_HEADINGS,
  };
}

function corroborateReadmeClaims(
  readmes: QaReadmeFacts[],
  manifests: QaManifestFacts[],
  files: readonly CodeIntelligenceSourceFile[],
): QaReadmeFacts[] {
  const paths = new Set(files.map((file) => file.path));
  const hasManifest = manifests.some((manifest) => manifest.status === "valid");
  const scripts = new Set(manifests.flatMap((manifest) => manifest.scripts));
  const hasTypeScript = files.some((file) => /\.(?:ts|tsx|mts|cts)$/iu.test(file.path));
  const hasJavaScript = files.some((file) => /\.(?:js|jsx|mjs|cjs)$/iu.test(file.path));
  const hasPython = files.some((file) => /\.py$/iu.test(file.path));
  const hasNodeManifest = paths.has("package.json");
  return readmes.map((readme) => ({
    ...readme,
    claims: readme.claims.map((claim) => {
      if (claim.kind === "test_script") {
        return hasManifest
          ? { ...claim, status: scripts.has(claim.documentedValue) ? "corroborated" as const : "contradicted" as const, observedPath: "package.json" }
          : { ...claim, status: "unverified" as const };
      }
      if (claim.kind === "technology") {
        const observed = (
          (claim.documentedValue === "TypeScript" && hasTypeScript) ||
          (claim.documentedValue === "JavaScript" && hasJavaScript) ||
          (claim.documentedValue === "Python" && hasPython) ||
          (claim.documentedValue === "Node.js" && hasNodeManifest)
        );
        return observed
          ? { ...claim, status: "corroborated" as const, observedPath: claim.documentedValue === "Node.js" ? "package.json" : "<selected-source-file>" }
          : { ...claim, status: "unverified" as const };
      }
      // The imported text is a bounded selection, not a complete repository
      // inventory. A missing file reference therefore remains unverified.
      return paths.has(claim.documentedValue)
        ? { ...claim, status: "corroborated" as const, observedPath: claim.documentedValue }
        : { ...claim, status: "unverified" as const };
    }),
  }));
}

function analyzeManifest(file: CodeIntelligenceSourceFile): QaManifestFacts {
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (!parsed || typeof parsed !== "object") throw new Error("manifest is not an object");
    const manifest = parsed as Record<string, unknown>;
    const scripts = manifest.scripts && typeof manifest.scripts === "object"
      ? Object.keys(manifest.scripts as Record<string, unknown>).sort().slice(0, 64)
      : [];
    const dependencies = manifest.dependencies && typeof manifest.dependencies === "object"
      ? Object.keys(manifest.dependencies as Record<string, unknown>).length
      : 0;
    const developmentDependencies = manifest.devDependencies && typeof manifest.devDependencies === "object"
      ? Object.keys(manifest.devDependencies as Record<string, unknown>).length
      : 0;
    return {
      path: file.path,
      contentSha256: file.contentSha256,
      status: "valid",
      scripts,
      dependencyCount: dependencies,
      developmentDependencyCount: developmentDependencies,
    };
  } catch {
    return {
      path: file.path,
      contentSha256: file.contentSha256,
      status: "invalid",
      scripts: [],
      dependencyCount: 0,
      developmentDependencyCount: 0,
    };
  }
}

/**
 * Parses only caller-provided source text. It deliberately does not create a
 * TypeScript Program, resolve imports, read the filesystem, or execute code.
 */
function unavailablePythonFile(file: CodeIntelligenceSourceFile): QaCodeFileMetrics {
  return {
    path: file.path,
    contentSha256: file.contentSha256,
    language: "python",
    status: "unavailable",
    physicalLines: file.content === "" ? 0 : file.content.split(/\r?\n/u).length,
    codeLines: null,
    cyclomaticComplexity: null,
    maxNesting: null,
    metricPrecision: {
      physicalLines: "exact_under_model",
      codeLines: "unknown",
      cyclomaticComplexity: "unknown",
      maxNesting: "unknown",
    },
    parseDiagnostics: 0,
    symbols: [],
    relations: [],
    truncated: false,
  };
}

function normalizePythonMetrics(input: QaPythonAstFileMetrics): QaCodeFileMetrics {
  return {
    ...input,
    symbols: input.symbols.map((symbol) => ({ ...symbol, exported: false })),
  };
}

/**
 * Parses JavaScript/TypeScript locally and joins only validated output from the
 * internal Python AST service. Both paths receive caller-provided source text;
 * neither path resolves imports or opens source paths from the host.
 */
export function analyzeRepositoryCode(
  files: readonly CodeIntelligenceSourceFile[],
  pythonMetrics: readonly QaPythonAstFileMetrics[] = [],
): QaCodeIntelligenceReport {
  const analyzedFiles: QaCodeFileMetrics[] = [];
  const readmes: QaReadmeFacts[] = [];
  const manifests: QaManifestFacts[] = [];
  let unsupported = 0;
  let pythonFiles = 0;
  let unavailablePythonFileCount = 0;
  const pythonByPath = new Map(pythonMetrics.map((metric) => [metric.path, metric]));

  for (const file of files) {
    const language = languageForPath(file.path);
    if (language) {
      analyzedFiles.push(analyzeTypeScriptFile(file));
      continue;
    }
    if (/\.py$/iu.test(file.path)) {
      pythonFiles += 1;
      const metric = pythonByPath.get(file.path);
      if (metric && metric.contentSha256 === file.contentSha256) {
        analyzedFiles.push(normalizePythonMetrics(metric));
      } else {
        unavailablePythonFileCount += 1;
        analyzedFiles.push(unavailablePythonFile(file));
      }
      continue;
    }
    if (/^(?:readme|contributing)\.md$/iu.test(file.path.split("/").at(-1) ?? "")) {
      readmes.push(analyzeReadme(file));
      continue;
    }
    if (file.path === "package.json") {
      manifests.push(analyzeManifest(file));
      continue;
    }
    unsupported += 1;
  }

  const languageCounts = {
    javascript: analyzedFiles.filter((file) => file.language === "javascript").length,
    typescript: analyzedFiles.filter((file) => file.language === "typescript").length,
    python: pythonFiles,
    unsupported,
  };
  const corroboratedReadmes = corroborateReadmeClaims(readmes, manifests, files);
  return {
    version: QA_CODE_INTELLIGENCE_VERSION,
    analyzedFiles,
    readmes: corroboratedReadmes,
    manifests,
    summary: {
      analyzedFileCount: files.length,
      parsedFileCount: analyzedFiles.filter((file) => file.status === "parsed").length,
      symbolCount: analyzedFiles.reduce((total, file) => total + file.symbols.length, 0),
      relationCount: analyzedFiles.reduce((total, file) => total + file.relations.length, 0),
      languageCounts,
      parseDiagnosticCount: analyzedFiles.reduce((total, file) => total + file.parseDiagnostics, 0),
      unavailablePythonFileCount,
    },
    limitations: [
      "El análisis TypeScript/JavaScript usa AST sobre texto ya recuperado; no crea un Program ni resuelve importaciones desde el sistema de archivos.",
      "Las relaciones de importación y llamada son sintácticas y se marcan como no resueltas; no demuestran flujo de datos, ejecución ni vulnerabilidad.",
      "El análisis Python se solicita al endpoint interno con límites de tamaño, profundidad, resultados y tiempo; si no está disponible, el informe identifica esos archivos como no analizados en vez de inferir sus estructuras.",
      "La complejidad ciclomática es exacta solo bajo el modelo sintáctico documentado (base 1 más decisiones y operadores booleanos); no mide coste, cobertura ni rutas en tiempo de ejecución.",
    ],
  };
}

/** Returns actual AST call sites, excluding comments and string literals. */
export function findDynamicEvalCalls(file: CodeIntelligenceSourceFile): QaCodeLocation[] {
  const scriptKind = scriptKindForPath(file.path);
  if (scriptKind === null) return [];
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind);
  const locations: QaCodeLocation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval"
    ) {
      locations.push({
        filePath: file.path,
        startLine: lineAt(source, node.getStart(source)),
        endLine: lineAt(source, node.getEnd()),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return locations;
}
