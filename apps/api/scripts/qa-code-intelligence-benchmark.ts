import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { QaPythonAstFileMetrics } from "../src/code-intelligence.js";
import {
  analyzeQaProject,
  type QaRepositoryInventory,
  type QaSourceFile,
} from "../src/qa-analysis.js";
import { requestPythonAstMetrics } from "../src/python-code-intelligence-client.js";

type ExpectedFinding = {
  ruleId: string;
  filePath: string;
  selected: boolean;
};

type BenchmarkCase = {
  name: "small" | "medium" | "large";
  allFiles: QaSourceFile[];
  selectedFiles: QaSourceFile[];
  expected: ExpectedFinding[];
};

type BenchmarkResult = {
  name: BenchmarkCase["name"];
  detector: {
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    evaluableExpectedFindings: number;
    nonEvaluableExpectedFindings: number;
  };
  selectionCoverage: {
    accessibleGroundTruthCases: number;
    totalGroundTruthCases: number;
    coverage: number | null;
  };
  citations: { valid: number; invalid: number };
  execution: {
    elapsedMs: number;
    inspectedFiles: number;
    pythonAstFiles: number;
    heapUsedBeforeBytes: number;
    heapUsedAfterBytes: number;
    peakMemory: "not_measured";
  };
};

const RULE_IDS = new Set([
  "qa.security.dynamic_eval",
  "qa.security.python_eval",
  "qa.security.python_shell_true_nonliteral",
  "qa.quality.high_cyclomatic_complexity",
  "qa.quality.syntax_error",
]);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function source(path: string, content: string): QaSourceFile {
  return {
    path,
    content,
    contentSha256: sha256(content),
    byteLength: Buffer.byteLength(content, "utf8"),
  };
}

function highComplexityTypeScript(): string {
  return [
    "export function complex(value: number) {",
    "  if (value > 0) value += 1;",
    "  if (value > 1) value += 1;",
    "  if (value > 2) value += 1;",
    "  if (value > 3) value += 1;",
    "  if (value > 4) value += 1;",
    "  if (value > 5) value += 1;",
    "  if (value > 6) value += 1;",
    "  if (value > 7) value += 1;",
    "  if (value > 8) value += 1;",
    "  return value;",
    "}",
  ].join("\n");
}

function fixture(name: BenchmarkCase["name"], targetFiles: number): BenchmarkCase {
  const allFiles: QaSourceFile[] = [
    source("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } })),
    source("README.md", "# Deterministic QA fixture\n\nTypeScript and Python are inspected as text only.\n"),
  ];
  const expected: ExpectedFinding[] = [];
  const add = (path: string, content: string, expectedRuleId?: string): void => {
    allFiles.push(source(path, content));
    if (expectedRuleId) expected.push({ ruleId: expectedRuleId, filePath: path, selected: true });
  };
  add("src/dynamic.ts", "export const parsed = eval(input);\n", "qa.security.dynamic_eval");
  add("src/eval-comment.ts", "// eval(untrusted) is documentation only\nexport const label = 'eval(value)';\n");
  add("src/complex.ts", highComplexityTypeScript(), "qa.quality.high_cyclomatic_complexity");
  add("src/eval.py", "def parse(value):\n    return eval(value)\n", "qa.security.python_eval");
  add("src/shell.py", "import subprocess\ndef execute(command):\n    return subprocess.run(command, shell=True)\n", "qa.security.python_shell_true_nonliteral");
  add("src/shell-constant.py", "import subprocess\nsubprocess.run('echo fixed', shell=True)\n");
  add("src/broken.py", "def broken(:\n    pass\n", "qa.quality.syntax_error");
  while (allFiles.length < targetFiles - 1) {
    const index = allFiles.length;
    const extension = index % 3 === 0 ? "py" : index % 2 === 0 ? "ts" : "js";
    const content = extension === "py"
      ? `def utility_${index}(value):\n    return value\n`
      : `export const utility${index} = (value) => value;\n`;
    add(`src/utility-${index}.${extension}`, content);
  }
  const inaccessible = source("src/not-selected.py", "def hidden(value):\n    return exec(value)\n");
  allFiles.push(inaccessible);
  expected.push({ ruleId: "qa.security.python_exec", filePath: inaccessible.path, selected: false });
  const selectedFiles = allFiles.filter((file) => file.path !== inaccessible.path);
  return { name, allFiles, selectedFiles, expected };
}

function inventory(discoveredFiles: number, selectedFiles: number): QaRepositoryInventory {
  return {
    selectionStrategy: "category_priority_v1",
    discoveredFiles,
    selectedFiles,
    categories: [
      { category: "manifest", discovered: 1, selected: 1 },
      { category: "test_configuration", discovered: 0, selected: 0 },
      { category: "source", discovered: discoveredFiles - 2, selected: selectedFiles - 2 },
      { category: "test", discovered: 0, selected: 0 },
      { category: "documentation", discovered: 1, selected: 1 },
      { category: "other", discovered: 0, selected: 0 },
    ],
    testFiles: { discovered: 0, selected: 0 },
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

async function benchmarkCase(
  fixtureCase: BenchmarkCase,
  pythonUrl: string,
): Promise<BenchmarkResult> {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const pythonMetrics = await requestPythonAstMetrics(fixtureCase.selectedFiles, {
    aiOrchestratorUrl: pythonUrl,
    timeoutMs: 4_000,
  });
  const selectedPython = fixtureCase.selectedFiles.filter((file) => /\.py$/iu.test(file.path));
  if (pythonMetrics.length !== selectedPython.length) {
    throw new Error(`python_ast_unavailable_for_${fixtureCase.name}`);
  }
  const report = analyzeQaProject({
    repositoryUrl: `https://benchmark.invalid/${fixtureCase.name}`,
    revision: `fixture-${fixtureCase.name}-v1`,
    files: fixtureCase.selectedFiles,
    inventory: inventory(fixtureCase.allFiles.length, fixtureCase.selectedFiles.length),
    pythonMetrics: pythonMetrics as QaPythonAstFileMetrics[],
  });
  const elapsedMs = Number((performance.now() - started).toFixed(1));
  const expectedEvaluable = fixtureCase.expected.filter((item) => item.selected);
  const expectedKeys = new Set(expectedEvaluable.map((item) => `${item.ruleId}:${item.filePath}`));
  const actual = report.findings.filter((finding) => RULE_IDS.has(finding.ruleId));
  const actualKeys = new Set(actual.map((finding) => `${finding.ruleId}:${finding.evidence.filePath}`));
  const tp = [...actualKeys].filter((key) => expectedKeys.has(key)).length;
  const fp = [...actualKeys].filter((key) => !expectedKeys.has(key)).length;
  const fn = [...expectedKeys].filter((key) => !actualKeys.has(key)).length;
  const citations = actual.reduce((counts, finding) => {
    const file = fixtureCase.selectedFiles.find((candidate) => candidate.path === finding.evidence.filePath);
    const valid = Boolean(
      file && file.contentSha256 === finding.evidence.contentSha256 &&
      finding.evidence.startLine >= 1 &&
      finding.evidence.endLine >= finding.evidence.startLine &&
      finding.evidence.endLine <= file.content.split(/\r?\n/u).length,
    );
    if (valid) counts.valid += 1;
    else counts.invalid += 1;
    return counts;
  }, { valid: 0, invalid: 0 });
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    name: fixtureCase.name,
    detector: {
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: precision === null || recall === null || precision + recall === 0
        ? null
        : Number((2 * precision * recall / (precision + recall)).toFixed(4)),
      evaluableExpectedFindings: expectedEvaluable.length,
      nonEvaluableExpectedFindings: fixtureCase.expected.length - expectedEvaluable.length,
    },
    selectionCoverage: {
      accessibleGroundTruthCases: expectedEvaluable.length,
      totalGroundTruthCases: fixtureCase.expected.length,
      coverage: ratio(expectedEvaluable.length, fixtureCase.expected.length),
    },
    citations,
    execution: {
      elapsedMs,
      inspectedFiles: fixtureCase.selectedFiles.length,
      pythonAstFiles: selectedPython.length,
      heapUsedBeforeBytes: before,
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
      peakMemory: "not_measured",
    },
  };
}

function markdown(results: BenchmarkResult[]): string {
  const rows = results.map((result) =>
    `| ${result.name} | ${result.execution.inspectedFiles} | ${result.detector.tp} | ${result.detector.fp} | ${result.detector.fn} | ${result.detector.precision ?? "n/a"} | ${result.detector.recall ?? "n/a"} | ${result.detector.f1 ?? "n/a"} | ${result.selectionCoverage.coverage ?? "n/a"} | ${result.citations.valid}/${result.citations.invalid} | ${result.execution.elapsedMs} |`,
  );
  return [
    "# QA Code Intelligence Benchmark",
    "",
    "Fixtures are synthetic and local. They never call GitHub or execute imported code. Detector quality is calculated only for ground-truth cases in selected files; selection coverage reports selected ground-truth cases over all ground-truth cases.",
    "",
    "| Fixture | Inspected | TP | FP | FN | Precision | Recall | F1 | Selection coverage | Valid/invalid citations | ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "Denominator convention: when a denominator is zero, the corresponding ratio is `null`/`n/a`, never treated as 1. Peak memory is not measured by this in-process harness; before/after heap values are reported only as diagnostics.",
  ].join("\n");
}

function option(name: string): string | undefined {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  return argument?.slice(name.length + 3);
}

const outputDirectory = option("output");
const pythonUrl = option("python-url") ?? process.env.AI_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000";
if (!outputDirectory) {
  throw new Error("usage: benchmark:code-intelligence -- --output=<directory> [--python-url=<url>]");
}
const results = [];
for (const item of [fixture("small", 10), fixture("medium", 50), fixture("large", 250)]) {
  results.push(await benchmarkCase(item, pythonUrl));
}
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const report = {
  benchmarkVersion: "qa-code-intelligence-benchmark-v1",
  generatedAt: new Date().toISOString(),
  source: "synthetic_local_fixtures",
  detectorRules: [...RULE_IDS].sort(),
  denominatorConvention: "null when denominator is zero",
  results,
};
await writeFile(resolve(output, "qa-code-intelligence-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "qa-code-intelligence-benchmark.md"), `${markdown(results)}\n`, "utf8");
console.log(JSON.stringify(report));
