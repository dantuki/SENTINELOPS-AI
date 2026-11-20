import { createHash } from "node:crypto";
import ts from "typescript-compiler-api";

export const QA_CODE_INTELLIGENCE_VERSION = "qa-code-intelligence-v1";

export interface CodeIntelligenceSourceFile {
  path: string;
  content: string;
  contentSha256: string;
  byteLength: number;
}

export interface QaCodeSymbol {
  id: string;
  name: string;
  kind: "class" | "function" | "interface" | "method" | "type" | "variable";
  exported: boolean;
  startLine: number;
  endLine: number;
  parameterCount: number | null;
}

export interface QaCodeRelation {
  kind: "calls" | "extends" | "implements" | "imports";
  from: string;
  to: string;
  startLine: number;
  resolved: false;
}

export interface QaCodeFileMetrics {
  path: string;
  contentSha256: string;
  language: "javascript" | "typescript";
  physicalLines: number;
  codeLines: number;
  cyclomaticComplexity: number;
  maxNesting: number;
  parseDiagnostics: number;
  symbols: QaCodeSymbol[];
  relations: QaCodeRelation[];
  truncated: boolean;
}

export interface QaReadmeFacts {
  path: string;
  contentSha256: string;
  headings: string[];
  mentionsTests: boolean;
  mentionsInstall: boolean;
  truncated: boolean;
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
    languageCounts: { javascript: number; typescript: number; unsupported: number };
    parseDiagnosticCount: number;
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

  const addRelation = (kind: QaCodeRelation["kind"], from: string, to: string, node: ts.Node): void => {
    if (relations.length >= MAX_RELATIONS_PER_FILE) {
      truncated = true;
      return;
    }
    relations.push({ kind, from, to, startLine: lineAt(source, node.getStart(source)), resolved: false });
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
      if (!addSymbol(symbols, source, file, node, "function", node.parameters.length)) truncated = true;
      nextOwner = nameFor(node) ?? owner;
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      if (!addSymbol(symbols, source, file, node, "method", node.parameters.length)) truncated = true;
      nextOwner = nameFor(node) ?? owner;
    } else if (ts.isClassDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "class")) truncated = true;
      nextOwner = nameFor(node) ?? owner;
    } else if (ts.isInterfaceDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "interface")) truncated = true;
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "type")) truncated = true;
    } else if (ts.isVariableDeclaration(node)) {
      if (!addSymbol(symbols, source, file, node, "variable")) truncated = true;
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addRelation("imports", owner, node.moduleSpecifier.text, node);
    } else if (ts.isCallExpression(node)) {
      const target = expressionName(node.expression);
      if (target) addRelation("calls", owner, target, node);
    } else if (ts.isHeritageClause(node)) {
      const kind = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of node.types) addRelation(kind, owner, type.expression.getText(source).slice(0, 200), type);
    }

    ts.forEachChild(node, (child) => visit(child, nextOwner));
    if (nested) nesting -= 1;
  };

  visit(source);
  return {
    path: file.path,
    contentSha256: file.contentSha256,
    language,
    physicalLines: file.content === "" ? 0 : file.content.split(/\r?\n/u).length,
    codeLines: countCodeLines(source),
    cyclomaticComplexity: complexity,
    maxNesting: maximumNesting,
    parseDiagnostics: (
      source as unknown as { parseDiagnostics?: readonly unknown[] }
    ).parseDiagnostics?.length ?? 0,
    symbols,
    relations,
    truncated,
  };
}

function analyzeReadme(file: CodeIntelligenceSourceFile): QaReadmeFacts {
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
    truncated: headings.length > MAX_DOCUMENTATION_HEADINGS,
  };
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
export function analyzeRepositoryCode(files: readonly CodeIntelligenceSourceFile[]): QaCodeIntelligenceReport {
  const analyzedFiles: QaCodeFileMetrics[] = [];
  const readmes: QaReadmeFacts[] = [];
  const manifests: QaManifestFacts[] = [];
  let unsupported = 0;

  for (const file of files) {
    const language = languageForPath(file.path);
    if (language) {
      analyzedFiles.push(analyzeTypeScriptFile(file));
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
    unsupported,
  };
  return {
    version: QA_CODE_INTELLIGENCE_VERSION,
    analyzedFiles,
    readmes,
    manifests,
    summary: {
      analyzedFileCount: files.length,
      parsedFileCount: analyzedFiles.length,
      symbolCount: analyzedFiles.reduce((total, file) => total + file.symbols.length, 0),
      relationCount: analyzedFiles.reduce((total, file) => total + file.relations.length, 0),
      languageCounts,
      parseDiagnosticCount: analyzedFiles.reduce((total, file) => total + file.parseDiagnostics, 0),
    },
    limitations: [
      "El análisis TypeScript/JavaScript usa AST sobre texto ya recuperado; no crea un Program ni resuelve importaciones desde el sistema de archivos.",
      "Las relaciones de importación y llamada son sintácticas y se marcan como no resueltas; no demuestran flujo de datos, ejecución ni vulnerabilidad.",
      "Los archivos Python y otros lenguajes se inventarían, pero su análisis AST aún no está integrado en este motor Node.js.",
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
