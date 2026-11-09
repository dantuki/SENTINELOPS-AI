import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  HABITUAL_VOLUME_NAME,
  POSTGRES_IMAGE,
  assertContainerIdentity,
  assertTemporaryDatabaseName,
  assertTemporaryPort,
  buildApiEnvironment,
  buildEvaluatorEnvironment,
  buildOrchestratorEnvironment,
  createContainerName,
  createRunId,
  createTemporaryDatabaseName,
  finalizeEvaluationOutput,
  getAnonymousPostgresVolumeName,
  missingOllamaModels,
  parseDockerPort,
  redactSecrets,
  resolveEvaluationResult,
  summarizeEvaluationOutput,
  systemEnvironment,
  RUNNER_LABEL,
  RUNNER_LABEL_VALUE,
  RUN_ID_LABEL,
  type TemporaryDatabase,
} from "../scripts/inc001-isolated-lib.js";
import {
  type Inc001GroundTruth,
} from "../src/inc001-evaluation.js";
import { renderInvestigationAnalysis } from "../src/investigation-analysis.js";
import {
  hashChunkContent,
  type EvidenceManifestItem,
  PostgresRetrievalTraceStore,
} from "../src/retrieval-trace.js";
import {
  RetrievalTraceVerifier,
  type RetrievalTraceExpectation,
} from "../src/retrieval-trace-verifier.js";
import type { Pool } from "pg";
import {
  classifyContainerCleanup,
  classifyDockerInspect,
  classifyVolumeCleanup,
  cleanupIsVerified,
  classifyProcessStop,
  parseEvaluationFailureStage,
  registerTerminationHandlers,
  recordTerminationReason,
  resolveContainerCandidate,
  TerminationController,
  type CommandResult,
} from "../scripts/inc001-runner-lifecycle.js";
import {
  POSTGRES_INTEGRATION_RUN_ID_LABEL,
  POSTGRES_INTEGRATION_RUNNER_LABEL,
  POSTGRES_INTEGRATION_RUNNER_VALUE,
  assertPostgresContainerIdentity,
  buildPostgresContainerArgs,
  cleanupTemporaryPostgresContainer,
} from "../scripts/postgres-integration-lifecycle.js";
import {
  ManagedProcess,
  type ManagedChild,
  type ManagedProcessRuntime,
} from "../scripts/managed-process.js";

const database: TemporaryDatabase = {
  port: 49_153,
  database: "sentinelops_inc001_eval_1760000000000",
  user: "sentinelops_eval",
  password: "temporary-password-value",
};
const endpoints = {
  apiPort: 49_200,
  orchestratorPort: 49_201,
  serviceKey: "service-key-with-at-least-thirty-two-characters",
};
const hostEnvironment: NodeJS.ProcessEnv = {
  PATH: "C:\\bin",
  SystemRoot: "C:\\Windows",
  POSTGRES_PASSWORD: "habitual-password",
  POSTGRES_DB: "habitual_db",
  OPENAI_API_KEY: "habitual-key",
  SENTINELOPS_EVAL_PASSWORD: "habitual-eval",
};

function inspected(overrides: {
  mounts?: unknown[];
  hostIp?: string;
  autoRemove?: boolean;
  id?: string;
  labelRunId?: string;
} = {}): unknown {
  const runId = createRunId();
  const name = createContainerName(runId);
  return {
    name,
    runId,
    document: [
      {
        Id: overrides.id ?? "abc123",
        Name: `/${name}`,
        Config: {
          Image: POSTGRES_IMAGE,
          Labels: {
            [RUNNER_LABEL]: RUNNER_LABEL_VALUE,
            [RUN_ID_LABEL]: overrides.labelRunId ?? runId,
          },
        },
        Mounts: overrides.mounts ?? [
          {
            Type: "volume",
            Name: "a".repeat(64),
            Destination: "/var/lib/postgresql",
          },
        ],
        HostConfig: {
          AutoRemove: overrides.autoRemove ?? true,
          Binds: null,
          PortBindings: {
            "5432/tcp": [{ HostIp: overrides.hostIp ?? "127.0.0.1", HostPort: "" }],
          },
        },
        NetworkSettings: {
          Ports: {
            "5432/tcp": [
              { HostIp: overrides.hostIp ?? "127.0.0.1", HostPort: "49153" },
            ],
          },
        },
      },
    ],
  };
}

function check(overrides: Parameters<typeof inspected>[0] = {}): void {
  const { name, runId, document } = inspected(overrides) as {
    name: string;
    runId: string;
    document: unknown;
  };
  assertContainerIdentity(document, {
    id: "abc123",
    name,
    runId,
    image: POSTGRES_IMAGE,
    port: 49_153,
  });
}

function postgresContainerInspection(overrides: {
  id?: string;
  name?: string;
  runId?: string;
  image?: string;
  hostIp?: string;
  binds?: unknown;
  volumeName?: string;
} = {}): unknown {
  const runId = overrides.runId ?? "a".repeat(32);
  const name = overrides.name ?? `sentinelops-postgres-integration-${runId}`;
  const id = overrides.id ?? "b".repeat(64);
  return [
    {
      Id: id,
      Name: `/${name}`,
      Config: {
        Image: overrides.image ?? POSTGRES_IMAGE,
        Labels: {
          [POSTGRES_INTEGRATION_RUNNER_LABEL]:
            POSTGRES_INTEGRATION_RUNNER_VALUE,
          [POSTGRES_INTEGRATION_RUN_ID_LABEL]: runId,
        },
      },
      Mounts: [
        {
          Type: "volume",
          Name: overrides.volumeName ?? "c".repeat(64),
          Destination: "/var/lib/postgresql",
        },
      ],
      HostConfig: {
        AutoRemove: true,
        Binds: overrides.binds ?? null,
        PortBindings: {
          "5432/tcp": [{ HostIp: overrides.hostIp ?? "127.0.0.1", HostPort: "0" }],
        },
      },
      NetworkSettings: {
        Ports: {
          "5432/tcp": [
            { HostIp: overrides.hostIp ?? "127.0.0.1", HostPort: "49153" },
          ],
        },
      },
    },
  ];
}

test("Docker inspect distinguishes absent, unavailable, timeout and unknown", () => {
  assert.equal(
    classifyDockerInspect({
      status: 0,
      stdout: JSON.stringify([{ Id: "container-id" }]),
      stderr: "",
    }),
    "PRESENT",
  );
  assert.equal(
    classifyDockerInspect({
      status: 1,
      stdout: "",
      stderr: "Error: No such object: container-id",
    }),
    "ABSENT",
  );
  assert.equal(
    classifyDockerInspect({
      status: 1,
      stdout: "",
      stderr: "error during connect: Docker daemon is unavailable",
    }),
    "DAEMON_UNAVAILABLE",
  );
  assert.equal(
    classifyDockerInspect({
      status: null,
      stdout: "",
      stderr: "timed out",
      errorCode: "ETIMEDOUT",
      timedOut: true,
    }),
    "TIMEOUT",
  );
  assert.equal(
    classifyDockerInspect({
      status: 1,
      stdout: "",
      stderr: "permission denied",
    }),
    "UNKNOWN",
  );
});

test("PostgreSQL runner never places its password in Docker arguments", () => {
  const args = buildPostgresContainerArgs({
    name: `sentinelops-postgres-integration-${"a".repeat(32)}`,
    runId: "a".repeat(32),
    cidfile: "C:\\Temp\\postgres.cid",
    image: POSTGRES_IMAGE,
    database: "sentinelops_phase31_isolation_1",
    user: "sentinelops_test",
  });
  assert.ok(args.includes("POSTGRES_PASSWORD"));
  assert.equal(args.some((arg) => arg.startsWith("POSTGRES_PASSWORD=")), false);
  assert.ok(args.includes("127.0.0.1::5432"));
  assert.ok(args.includes("--cidfile"));
  assert.ok(args.includes("--rm"));
});

test("PostgreSQL container identity requires runner ownership and isolated networking/storage", () => {
  const runId = "a".repeat(32);
  const name = `sentinelops-postgres-integration-${runId}`;
  const expected = {
    id: "b".repeat(12),
    name,
    runId,
    image: POSTGRES_IMAGE,
    port: 49_153,
  };
  assert.equal(
    assertPostgresContainerIdentity(
      postgresContainerInspection(),
      expected,
    ),
    "c".repeat(64),
  );
  assert.throws(() =>
    assertPostgresContainerIdentity(
      postgresContainerInspection({ hostIp: "0.0.0.0" }),
      expected,
    ),
  );
  assert.throws(() =>
    assertPostgresContainerIdentity(
      postgresContainerInspection({ binds: ["C:\\data:/var/lib/postgresql"] }),
      expected,
    ),
  );
  assert.throws(() =>
    assertPostgresContainerIdentity(
      postgresContainerInspection({ volumeName: HABITUAL_VOLUME_NAME }),
      expected,
    ),
  );
  assert.throws(() =>
    assertPostgresContainerIdentity(
      postgresContainerInspection({ runId: "d".repeat(32) }),
      expected,
    ),
  );
});

test("partial PostgreSQL container creation is cleaned only after identity verification", () => {
  const runId = "a".repeat(32);
  const containerName = `sentinelops-postgres-integration-${runId}`;
  const containerId = "b".repeat(64);
  let removed = false;
  const calls: string[][] = [];
  const runDocker = (args: string[]): CommandResult => {
    calls.push(args);
    if (args[0] === "ps") {
      return {
        status: 1,
        stdout: "",
        stderr: "Docker daemon unavailable",
      };
    }
    if (args[0] === "inspect" && args[1] === containerId) {
      return removed
        ? {
            status: 1,
            stdout: "",
            stderr: `Error: No such object: ${containerId}`,
          }
        : {
            status: 0,
            stdout: JSON.stringify(postgresContainerInspection()),
            stderr: "",
          };
    }
    if (args[0] === "rm") {
      removed = true;
      return { status: 0, stdout: containerId, stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        status: 1,
        stdout: "",
        stderr: `Error: no such volume: ${"c".repeat(64)}`,
      };
    }
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  };

  const cleanup = cleanupTemporaryPostgresContainer({
    containerName,
    runId,
    image: POSTGRES_IMAGE,
    cidfile: containerId,
    runDocker,
  });
  assert.equal(cleanup.success, true);
  assert.equal(cleanup.container, "removed");
  assert.equal(cleanup.volume, "removed");
  assert.equal(removed, true);
  assert.ok(calls.some((args) => args[0] === "rm" && args.includes("--volumes")));
});

test("PostgreSQL cleanup refuses to remove a container with mismatched ownership", () => {
  const runId = "a".repeat(32);
  const containerName = `sentinelops-postgres-integration-${runId}`;
  const containerId = "b".repeat(64);
  let removed = false;
  const runDocker = (args: string[]): CommandResult => {
    if (args[0] === "ps") {
      return { status: 0, stdout: containerId, stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify(
          postgresContainerInspection({ runId: "d".repeat(32) }),
        ),
        stderr: "",
      };
    }
    if (args[0] === "rm") {
      removed = true;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const cleanup = cleanupTemporaryPostgresContainer({
    containerName,
    runId,
    image: POSTGRES_IMAGE,
    cidfile: null,
    runDocker,
  });
  assert.equal(cleanup.success, false);
  assert.equal(removed, false);
  assert.ok(cleanup.errors.length > 0);
});

test("PostgreSQL cleanup reports a persistent owned container without claiming success", () => {
  const runId = "a".repeat(32);
  const containerName = `sentinelops-postgres-integration-${runId}`;
  const containerId = "b".repeat(64);
  const calls: string[][] = [];
  const runDocker = (args: string[]): CommandResult => {
    calls.push(args);
    if (args[0] === "ps") {
      return { status: 0, stdout: containerId, stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === containerId) {
      return {
        status: 0,
        stdout: JSON.stringify(postgresContainerInspection()),
        stderr: "",
      };
    }
    if (args[0] === "rm") {
      return { status: 1, stdout: "", stderr: "container is still running" };
    }
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  };

  const cleanup = cleanupTemporaryPostgresContainer({
    containerName,
    runId,
    image: POSTGRES_IMAGE,
    cidfile: containerId,
    runDocker,
  });
  assert.equal(cleanup.success, false);
  assert.equal(cleanup.container, "present");
  assert.equal(cleanup.volume, "present");
  assert.equal(cleanup.volumeName, "c".repeat(64));
  assert.equal(calls.some((args) => args[0] === "volume" && args[1] === "rm"), false);
});

test("PostgreSQL cleanup reports a surviving anonymous volume without removing it again", () => {
  const runId = "a".repeat(32);
  const containerName = `sentinelops-postgres-integration-${runId}`;
  const containerId = "b".repeat(64);
  const volumeName = "c".repeat(64);
  let removed = false;
  const calls: string[][] = [];
  const runDocker = (args: string[]): CommandResult => {
    calls.push(args);
    if (args[0] === "ps") {
      return { status: 0, stdout: containerId, stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === containerId) {
      return removed
        ? {
            status: 1,
            stdout: "",
            stderr: `Error: No such object: ${containerId}`,
          }
        : {
            status: 0,
            stdout: JSON.stringify(postgresContainerInspection({ volumeName })),
            stderr: "",
          };
    }
    if (args[0] === "rm") {
      removed = true;
      return { status: 0, stdout: containerId, stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify([{ Name: volumeName }]),
        stderr: "",
      };
    }
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  };

  const cleanup = cleanupTemporaryPostgresContainer({
    containerName,
    runId,
    image: POSTGRES_IMAGE,
    cidfile: containerId,
    runDocker,
  });
  assert.equal(cleanup.success, false);
  assert.equal(cleanup.container, "removed");
  assert.equal(cleanup.volume, "present");
  assert.match(cleanup.errors.join(" "), /at \/var\/lib\/postgresql/u);
  assert.equal(calls.some((args) => args[0] === "volume" && args[1] === "rm"), false);
});

function createWindowsProcessHarness(options: {
  pid?: number | null;
  taskkillStatus?: number | null;
  taskkillErrorCode?: string;
  descendants?: number[] | null;
  closeOnTaskkill?: boolean;
} = {}): {
  managed: ManagedProcess;
  calls: { taskkillPids: number[]; inspectedPids: number[] };
  close: (code: number | null, signal?: NodeJS.Signals | null) => void;
} {
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null =
    null;
  let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | null =
    null;
  const child: ManagedChild = {
    pid: options.pid === null ? undefined : options.pid ?? 4321,
    onStdoutData() {},
    onStderrData() {},
    onError() {},
    onExit(listener) {
      onExit = listener;
    },
    onClose(listener) {
      onClose = listener;
    },
  };
  const calls = { taskkillPids: [] as number[], inspectedPids: [] as number[] };
  const close = (code: number | null, signal: NodeJS.Signals | null = null) => {
    onExit?.(code, signal);
    onClose?.(code, signal);
  };
  const runtime: ManagedProcessRuntime = {
    platform: "win32",
    spawnChild: () => child,
    taskkill(pid) {
      calls.taskkillPids.push(pid);
      if (options.closeOnTaskkill) {
        close(0);
      }
      return {
        status: options.taskkillStatus ?? 0,
        errorCode: options.taskkillErrorCode,
      };
    },
    inspectWindowsDescendants(pid) {
      calls.inspectedPids.push(pid);
      return options.descendants === undefined ? [] : options.descendants;
    },
    killProcessGroup() {
      throw new Error("Windows lifecycle must not use Unix process groups.");
    },
    wait: async () => {},
  };
  return {
    managed: new ManagedProcess(
      "test",
      "fake-process",
      [],
      { cwd: "C:\\", env: {} },
      [],
      runtime,
    ),
    calls,
    close,
  };
}

test("ManagedProcess.stop exercises Windows taskkill, close and descendant verification", async () => {
  const stopped = createWindowsProcessHarness({ closeOnTaskkill: true });
  assert.equal(await stopped.managed.stop(), "stopped");
  assert.deepEqual(stopped.calls.taskkillPids, [4321]);
  assert.deepEqual(stopped.calls.inspectedPids, [4321]);

  const descendantsRemain = createWindowsProcessHarness({
    closeOnTaskkill: true,
    descendants: [9876],
  });
  assert.equal(await descendantsRemain.managed.stop(), "failed");

  const taskkillFailed = createWindowsProcessHarness({
    closeOnTaskkill: true,
    taskkillStatus: 1,
  });
  assert.equal(await taskkillFailed.managed.stop(), "unknown");

  const taskkillTimedOut = createWindowsProcessHarness({
    closeOnTaskkill: true,
    taskkillErrorCode: "ETIMEDOUT",
  });
  assert.equal(await taskkillTimedOut.managed.stop(), "unknown");

  const exitedBeforeStop = createWindowsProcessHarness();
  exitedBeforeStop.close(0);
  assert.equal(await exitedBeforeStop.managed.stop(), "stopped");
  assert.deepEqual(exitedBeforeStop.calls.taskkillPids, []);

  const unavailableDescendants = createWindowsProcessHarness({
    closeOnTaskkill: true,
    descendants: null,
  });
  assert.equal(await unavailableDescendants.managed.stop(), "unknown");

  const missingPid = createWindowsProcessHarness({ pid: null });
  assert.equal(await missingPid.managed.stop(), "unknown");

  const concurrentStops = createWindowsProcessHarness({ closeOnTaskkill: true });
  const concurrentResults = await Promise.all([
    concurrentStops.managed.stop(),
    concurrentStops.managed.stop(),
  ]);
  assert.deepEqual(concurrentResults, ["stopped", "stopped"]);
  assert.deepEqual(concurrentStops.calls.taskkillPids, [4321]);
});

test("process stop is successful only after taskkill and process close are confirmed", () => {
  assert.equal(classifyProcessStop(0, true, false), "stopped");
  assert.equal(classifyProcessStop(1, true, false), "unknown");
  assert.equal(classifyProcessStop(0, false, false), "failed");
  assert.equal(classifyProcessStop(0, false, true), "unknown");
});

test("evaluation failure diagnostics retain only known stage labels", () => {
  assert.equal(
    parseEvaluationFailureStage(
      "INC-001 evaluation failed [stage=investigation]: Product API request failed.",
    ),
    "investigation",
  );
  assert.equal(
    parseEvaluationFailureStage(
      "INC-001 evaluation failed [stage=unknown]: failure",
    ),
    null,
  );
  assert.equal(parseEvaluationFailureStage("unstructured stderr"), null);
});

test("partial container creation is reconciled only from an exact cidfile or one labeled ID", () => {
  assert.deepEqual(
    resolveContainerCandidate("a".repeat(64), {
      status: 1,
      stdout: "",
      stderr: "Docker response lost after create",
    }),
    { state: "candidate", id: "a".repeat(64) },
  );
  assert.deepEqual(
    resolveContainerCandidate(null, {
      status: 0,
      stdout: `${"b".repeat(64)}\n`,
      stderr: "",
    }),
    { state: "candidate", id: "b".repeat(64) },
  );
  assert.deepEqual(
    resolveContainerCandidate(null, { status: 0, stdout: "", stderr: "" }),
    { state: "absent" },
  );
  assert.deepEqual(
    resolveContainerCandidate(null, {
      status: 1,
      stdout: "",
      stderr: "Docker daemon unavailable",
    }),
    { state: "unknown" },
  );
  assert.deepEqual(
    resolveContainerCandidate(null, {
      status: 0,
      stdout: `${"a".repeat(64)}\n${"b".repeat(64)}`,
      stderr: "",
    }),
    { state: "unknown" },
  );
});

test("cleanup verification never treats unknown resources as removed", () => {
  assert.equal(classifyContainerCleanup("ABSENT"), "removed");
  assert.equal(classifyContainerCleanup("PRESENT"), "present");
  assert.equal(classifyContainerCleanup("DAEMON_UNAVAILABLE"), "unknown");
  assert.equal(classifyContainerCleanup("TIMEOUT"), "unknown");
  assert.equal(classifyVolumeCleanup("ABSENT", false), "removed");
  assert.equal(classifyVolumeCleanup("PRESENT", true), "present");
  assert.equal(classifyVolumeCleanup("PRESENT", false), "unknown");

  const verified = {
    processes: { api: "stopped" as const, evaluator: "not_started" as const },
    container: { state: "removed" as const, verified: true },
    volume: { state: "removed" as const, verified: true },
    errors: [],
  };
  assert.equal(cleanupIsVerified(verified), true);
  assert.equal(
    cleanupIsVerified({
      processes: { api: "not_started" },
      container: { state: "not_created", verified: true },
      volume: { state: "not_created", verified: true },
      errors: [],
    }),
    true,
  );
  assert.equal(
    cleanupIsVerified({
      ...verified,
      container: { state: "unknown", verified: false },
    }),
    false,
  );
  assert.equal(
    cleanupIsVerified({
      ...verified,
      processes: { api: "unknown" },
    }),
    false,
  );
});

test("temporary database names must follow the evaluation pattern", () => {
  assert.doesNotThrow(() =>
    assertTemporaryDatabaseName(createTemporaryDatabaseName(1_760_000_000_000)),
  );
  for (const name of [
    "sentinelops",
    "sentinelops_phase31_isolation_1",
    "sentinelops_inc001_eval_",
    "sentinelops_inc001_eval_1; DROP",
    "x_sentinelops_inc001_eval_1",
  ]) {
    assert.throws(() => assertTemporaryDatabaseName(name), name);
  }
});

test("the habitual PostgreSQL port and invalid ports are rejected", () => {
  assert.throws(() => assertTemporaryPort(5432));
  assert.throws(() => assertTemporaryPort(80));
  assert.throws(() => assertTemporaryPort(70_000));
  assert.throws(() => assertTemporaryPort(Number.NaN));
  assert.doesNotThrow(() => assertTemporaryPort(49_153));
});

test("docker port output must be loopback-only", () => {
  assert.equal(parseDockerPort("127.0.0.1:49153"), 49_153);
  assert.throws(() => parseDockerPort("0.0.0.0:49153"));
  assert.throws(() => parseDockerPort("127.0.0.1:49153\n[::]:49153"));
  assert.throws(() => parseDockerPort("127.0.0.1:5432"));
  assert.throws(() => parseDockerPort(""));
});

test("container identity accepts only this runner's loopback container", () => {
  assert.doesNotThrow(() => check());
  assert.throws(() => check({ id: "other" }));
  assert.throws(() => check({ labelRunId: "f".repeat(32) }));
  assert.throws(() => check({ hostIp: "0.0.0.0" }));
  assert.throws(() => check({ autoRemove: false }));
});

test("container identity rejects bind mounts and the habitual volume", () => {
  assert.throws(() =>
    check({
      mounts: [{ Type: "bind", Source: "C:\\data", Destination: "/var/lib/postgresql" }],
    }),
  );
  assert.throws(() =>
    check({
      mounts: [
        {
          Type: "volume",
          Name: HABITUAL_VOLUME_NAME,
          Destination: "/var/lib/postgresql",
        },
      ],
    }),
  );
  assert.throws(() =>
    check({
      mounts: [
        { Type: "volume", Name: "a".repeat(64), Destination: "/migrations" },
      ],
    }),
  );
});

test("anonymous database volume identity is singular and confined to PostgreSQL data", () => {
  const entry = inspected() as { document: unknown };
  assert.equal(
    getAnonymousPostgresVolumeName(entry.document),
    "a".repeat(64),
  );
  assert.throws(() =>
    getAnonymousPostgresVolumeName([
      {
        Mounts: [
          {
            Type: "volume",
            Name: HABITUAL_VOLUME_NAME,
            Destination: "/var/lib/postgresql",
          },
        ],
      },
    ]),
  );
});

test("system environment keeps only allowlisted variables", () => {
  const environment = systemEnvironment(hostEnvironment);
  assert.deepEqual(Object.keys(environment).sort(), ["PATH", "SystemRoot"]);
});

test("service environments never inherit habitual application variables", () => {
  const api = buildApiEnvironment(database, endpoints, hostEnvironment);
  assert.equal(api.POSTGRES_DB, database.database);
  assert.equal(api.POSTGRES_PASSWORD, database.password);
  assert.equal(api.POSTGRES_PORT, "49153");
  assert.equal(api.POSTGRES_HOST, "127.0.0.1");
  assert.equal(api.API_HOST, "127.0.0.1");
  assert.equal(api.SESSION_COOKIE_SECURE, "false");
  assert.equal(api.NODE_ENV, "development");
  assert.equal(api.AI_ORCHESTRATOR_URL, "http://127.0.0.1:49201");
  assert.equal(api.OPENAI_API_KEY, undefined);

  const orchestrator = buildOrchestratorEnvironment(endpoints, hostEnvironment);
  assert.equal(orchestrator.SENTINELOPS_ENV, "development");
  assert.equal(orchestrator.OLLAMA_CHAT_MODEL, "qwen3.5:4b");
  assert.equal(orchestrator.OLLAMA_EMBEDDING_MODEL, "qwen3-embedding:0.6b");
  assert.equal(orchestrator.POSTGRES_PASSWORD, undefined);
  assert.equal(orchestrator.OPENAI_API_KEY, undefined);

  const evaluator = buildEvaluatorEnvironment(
    endpoints,
    { email: "e@example.test", password: "generated-evaluator-password" },
    hostEnvironment,
  );
  assert.equal(evaluator.PRODUCT_API_URL, "http://127.0.0.1:49200");
  assert.equal(evaluator.SENTINELOPS_EVAL_PASSWORD, "generated-evaluator-password");
  assert.equal(evaluator.POSTGRES_PASSWORD, undefined);
  assert.equal(evaluator.POSTGRES_DB, undefined);
});

test("environment builders reject the habitual port and database names", () => {
  assert.throws(() =>
    buildApiEnvironment({ ...database, port: 5432 }, endpoints, hostEnvironment),
  );
  assert.throws(() =>
    buildApiEnvironment({ ...database, database: "sentinelops" }, endpoints, hostEnvironment),
  );
});

test("secrets are redacted from captured output", () => {
  assert.equal(
    redactSecrets("password=temporary-password-value ok", [
      "temporary-password-value",
    ]),
    "password=[redacted] ok",
  );
  assert.equal(redactSecrets("abc", ["abc"]), "abc");
});

test("missing Ollama models are reported from the tags payload", () => {
  assert.deepEqual(
    missingOllamaModels({ models: [{ name: "qwen3.5:4b" }] }),
    ["qwen3-embedding:0.6b"],
  );
  assert.deepEqual(
    missingOllamaModels({
      models: [{ name: "qwen3.5:4b" }, { name: "qwen3-embedding:0.6b" }],
    }),
    [],
  );
  assert.equal(missingOllamaModels(null).length, 2);
});

const evaluationGroundTruth: Inc001GroundTruth = {
  expected_observations: [
    { id: "OBS-01" },
    { id: "OBS-02" },
    { id: "OBS-03" },
    { id: "OBS-04" },
    { id: "OBS-05" },
    { id: "OBS-06" },
  ],
  must_not_claim: [],
};
const traceRunId = "11111111-1111-4111-8111-111111111111";
const traceRequestId = "22222222-2222-4222-8222-222222222222";
const traceProjectId = "33333333-3333-4333-8333-333333333333";
const traceChunkId = "44444444-4444-4444-8444-444444444444";
const traceDocumentId = "55555555-5555-4555-8555-555555555555";
const traceSourceId = "66666666-6666-4666-8666-666666666666";
const traceRetrievedAt = "2026-01-01T00:00:00.000Z";
const evaluationContent = [
      '{"request_id":"req-7841","attempts":5,"retry_mode":"parallel"}',
      '{"active_connections":20,"idle_connections":0,"waiting_requests":18}',
      '{"status_code":500,"error":"Timeout acquiring a connection","request_id":"req-7841"}',
      '{"queue_depth":42,"retries_started_last_minute":120}',
      '{"active_connections":20,"waiting_requests":31}',
      '{"service":"payment-gateway","status_code":200,"duration_ms":180}',
].join("\n");
const completeAnalysis = {
  summary: "Cinco intentos paralelos comparten req-7841.",
  summary_evidence_refs: ["E1"],
  observed_facts: [
    { claim: "Cinco intentos paralelos comparten req-7841.", evidence_refs: ["E1"] },
    { claim: "El pool llegó al máximo (20/20), con cero conexiones libres y 18 solicitudes esperando.", evidence_refs: ["E1"] },
    { claim: "req-7841 agotó el tiempo de espera al adquirir conexión y recibió HTTP 500.", evidence_refs: ["E1"] },
    { claim: "La cola de reintentos alcanzó 42, con 120 reintentos iniciados por minuto.", evidence_refs: ["E1"] },
    { claim: "La saturación persistió y llegó a 31 solicitudes pendientes.", evidence_refs: ["E1"] },
    { claim: "payment-gateway registró HTTP 200 en 180 ms.", evidence_refs: ["E1"] },
  ],
  hypotheses: [],
  missing_information: ["No se ha demostrado una causa raíz."],
  next_checks: ["Correlacionar eventos con trazas distribuidas."],
  limitations: ["La evidencia es sintética."],
};
const evaluationManifest: EvidenceManifestItem[] = [
  {
    evidenceId: traceChunkId,
    alias: "E1",
    runId: traceRunId,
    requestId: traceRequestId,
    projectId: traceProjectId,
    incidentId: "INC-001",
    chunkId: traceChunkId,
    documentId: traceDocumentId,
    sourceId: traceSourceId,
    ordinal: 0,
    rank: 1,
    score: 0.8,
    content: evaluationContent,
    contentHash: hashChunkContent(evaluationContent),
    evidenceScope: "incident_specific",
    retrievedAt: traceRetrievedAt,
  },
];
const verifiedTrace = {
  status: "verified" as const,
  verifiedCount: 1,
  unverifiedCount: 0,
  failedCount: 0,
  verificationErrors: [],
  verifiedEvidenceIds: [traceChunkId],
  requestId: traceRequestId,
  runId: traceRunId,
  evidence: [{ evidenceId: traceChunkId, status: "verified" as const }],
};

function createVerifierPool(
  rows: Record<string, unknown>[],
): Pick<Pool, "query"> {
  return {
    query: async () => ({
      rows,
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
    }),
  } as unknown as Pick<Pool, "query">;
}

function storedTraceRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const item = evaluationManifest[0]!;
  return {
    runId: traceRunId,
    requestId: traceRequestId,
    projectId: traceProjectId,
    incidentId: "INC-001",
    retrievedAt: new Date(traceRetrievedAt),
    rank: 1,
    chunkId: traceChunkId,
    documentId: traceDocumentId,
    sourceId: traceSourceId,
    projectItemId: traceProjectId,
    ordinal: 0,
    score: 0.8,
    contentHash: item.contentHash,
    evidenceScope: "incident_specific",
    itemRetrievedAt: new Date(traceRetrievedAt),
    content: evaluationContent,
    metadata: { incidentId: "INC-001" },
    documentSourceId: traceSourceId,
    documentStatus: "indexed",
    sourceStatus: "active",
    ...overrides,
  };
}

const traceExpectation: RetrievalTraceExpectation = {
  runId: traceRunId,
  requestId: traceRequestId,
  projectId: traceProjectId,
  incidentId: "INC-001",
  retrievedAt: traceRetrievedAt,
  manifest: evaluationManifest,
};

test("PostgreSQL retrieval trace storage commits atomically and rolls back on item failure", async () => {
  const statements: string[] = [];
  let released = false;
  const client = {
    query: async (statement: string) => {
      statements.push(statement.trim());
      return { rows: [], rowCount: 1 };
    },
    release: () => {
      released = true;
    },
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const store = new PostgresRetrievalTraceStore(pool);

  await store.createTrace({
    runId: traceRunId,
    requestId: traceRequestId,
    projectId: traceProjectId,
    incidentId: "INC-001",
    retrievedAt: traceRetrievedAt,
    items: evaluationManifest,
  });
  assert.deepEqual(statements.map((statement) => statement.split(/\s+/u)[0]), [
    "BEGIN",
    "INSERT",
    "INSERT",
    "COMMIT",
  ]);
  assert.equal(released, true);

  statements.length = 0;
  released = false;
  const failingClient = {
    ...client,
    query: async (statement: string) => {
      statements.push(statement.trim());
      if (statement.includes("INSERT INTO retrieval_event_items")) {
        throw new Error("forced trace insert failure");
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const failingStore = new PostgresRetrievalTraceStore({
    connect: async () => failingClient,
  } as unknown as Pool);
  await assert.rejects(
    failingStore.createTrace({
      runId: traceRunId,
      requestId: traceRequestId,
      projectId: traceProjectId,
      incidentId: "INC-001",
      retrievedAt: traceRetrievedAt,
      items: evaluationManifest,
    }),
    /forced trace insert failure/u,
  );
  assert.ok(statements.some((statement) => statement === "ROLLBACK"));
  assert.equal(released, true);
});

test("retrieval trace verifier confirms stored lineage, scope, content and same-run identity", async () => {
  const verified = await new RetrievalTraceVerifier(
    createVerifierPool([storedTraceRow()]),
  ).verifyTrace(traceExpectation);

  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.verifiedEvidenceIds, [traceChunkId]);

  const contentMismatch = await new RetrievalTraceVerifier(
    createVerifierPool([
      storedTraceRow({ content: "mutated stored content" }),
    ]),
  ).verifyTrace(traceExpectation);
  assert.equal(contentMismatch.status, "failed");
  assert.ok(
    contentMismatch.verificationErrors.some((error) =>
      error.includes("content_or_hash_mismatch"),
    ),
  );

  const scopeMismatch = await new RetrievalTraceVerifier(
    createVerifierPool([
      storedTraceRow({ metadata: { incidentId: "INC-002" } }),
    ]),
  ).verifyTrace(traceExpectation);
  assert.equal(scopeMismatch.status, "failed");
  assert.ok(
    scopeMismatch.verificationErrors.some((error) =>
      error.includes("scope_mismatch"),
    ),
  );

  const sourceLineageMismatch = await new RetrievalTraceVerifier(
    createVerifierPool([
      storedTraceRow({
        documentSourceId: "77777777-7777-4777-8777-777777777777",
      }),
    ]),
  ).verifyTrace(traceExpectation);
  assert.equal(sourceLineageMismatch.status, "failed");
  assert.ok(
    sourceLineageMismatch.verificationErrors.some((error) =>
      error.includes("lineage_or_order_mismatch"),
    ),
  );

  const runMismatch = await new RetrievalTraceVerifier(
    createVerifierPool([
      storedTraceRow({ runId: "77777777-7777-4777-8777-777777777777" }),
    ]),
  ).verifyTrace(traceExpectation);
  assert.equal(runMismatch.status, "failed");
  assert.ok(
    runMismatch.verificationErrors.includes(
      "retrieval_event_header_mismatch",
    ),
  );
});

function candidateEvaluationReport(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const candidate = {
    reportType: "inc001-candidate-v1",
    dataset: "sentinelops-synthetic-demo-v1",
    incidentId: "INC-001",
    model: "qwen3.5:4b",
    evidenceCount: evaluationManifest.length,
    runId: traceRunId,
    requestId: traceRequestId,
    retrievedAt: traceRetrievedAt,
    evidenceManifest: evaluationManifest,
    response: renderInvestigationAnalysis(completeAnalysis),
    analysis: completeAnalysis,
    ingestion: "completed",
    timings: { warmupMs: 10, ingestionMs: 20, investigationMs: 30 },
    abstained: false,
    referenceLeaked: false,
    ...overrides,
  };
  return candidate;
}

function validEvaluationReport(
  candidate: Record<string, unknown> = candidateEvaluationReport(),
  verification = verifiedTrace,
): Record<string, unknown> {
  return JSON.parse(
    finalizeEvaluationOutput(
      JSON.stringify(candidate),
      evaluationGroundTruth,
      traceRunId,
      verification,
    ),
  ) as Record<string, unknown>;
}

function summarizedReport(
  report: Record<string, unknown> = validEvaluationReport(),
) {
  return summarizeEvaluationOutput(JSON.stringify(report), evaluationGroundTruth);
}

test("evaluation report validation rejects empty, truncated, partial and malformed output", () => {
  for (const output of [
    "",
    "{",
    "not json",
    JSON.stringify({ passed: true, model: "m", timings: { warmupMs: 1 } }),
    JSON.stringify(candidateEvaluationReport()),
  ]) {
    const summary = summarizeEvaluationOutput(output, evaluationGroundTruth);
    assert.equal(summary.parsed, false);
    assert.equal(summary.passed, null);
    assert.deepEqual(summary.validationErrors, [
      "invalid or incomplete verified evaluation report",
    ]);
  }
});

test("runner recomputes claim coverage and evidence leakage from the verified manifest", () => {
  const genericAnalysis = {
    ...completeAnalysis,
    summary: "El sistema presenta varios eventos.",
    observed_facts: completeAnalysis.observed_facts.map((fact) => ({
      ...fact,
      claim: "El sistema presenta varios eventos.",
    })),
  };
  const generic = validEvaluationReport(
    candidateEvaluationReport({
      response: renderInvestigationAnalysis(genericAnalysis),
      analysis: genericAnalysis,
    }),
  );
  assert.equal(summarizedReport(generic).parsed, true);
  assert.equal(generic.passed, false);
  assert.equal(
    (generic.evaluation as Record<string, unknown>).answerCoverage,
    0,
  );

  const unrelatedManifest = evaluationManifest.map((item) => ({
    ...item,
    content: "No INC-001 observations are present.",
    contentHash: hashChunkContent("No INC-001 observations are present."),
  }));
  const unrelated = validEvaluationReport(
    candidateEvaluationReport({ evidenceManifest: unrelatedManifest }),
  );
  assert.equal(summarizedReport(unrelated).parsed, true);
  assert.equal(unrelated.passed, false);
  assert.equal(
    (unrelated.evaluation as Record<string, unknown>).retrievalRecall,
    0,
  );

  const leakedManifest = evaluationManifest.map((item) => ({
    ...item,
    content: `${item.content}\nsynthetic_evaluation_reference`,
    contentHash: hashChunkContent(`${item.content}\nsynthetic_evaluation_reference`),
  }));
  const leaked = validEvaluationReport(
    candidateEvaluationReport({
      evidenceManifest: leakedManifest,
      referenceLeaked: true,
    }),
  );
  assert.equal(summarizedReport(leaked).parsed, true);
  assert.equal(leaked.passed, false);
  assert.equal(leaked.referenceLeaked, true);
});

test("verified report integrity rejects altered output and requires a verified trace", () => {
  const valid = validEvaluationReport();
  assert.equal(summarizedReport(valid).parsed, true);
  assert.equal(
    summarizedReport(valid).passed,
    true,
    JSON.stringify(valid.evaluation),
  );

  const alteredMetrics = validEvaluationReport();
  (alteredMetrics.evaluation as Record<string, unknown>).retrievalRecall = 0.5;
  assert.equal(summarizedReport(alteredMetrics).parsed, false);

  const alteredCitation = validEvaluationReport();
  const evaluation = alteredCitation.evaluation as Record<string, unknown>;
  (evaluation.citations as Record<string, unknown>).invalid = ["[E2]"];
  assert.equal(summarizedReport(alteredCitation).parsed, false);

  const failedTrace = {
    ...verifiedTrace,
    status: "failed" as const,
    verifiedCount: 0,
    failedCount: 1,
    verificationErrors: ["content_or_hash_mismatch"],
    verifiedEvidenceIds: [],
    evidence: [{ evidenceId: traceChunkId, status: "failed" as const }],
  };
  const failed = validEvaluationReport(candidateEvaluationReport(), failedTrace);
  assert.equal(summarizedReport(failed).parsed, true);
  assert.equal(failed.passed, false);
});

test("a valid passing report and successful evaluator and cleanup are jointly required for PASS", () => {
  const result = resolveEvaluationResult(
    summarizedReport(),
    0,
    true,
    null,
    null,
  );
  assert.deepEqual(result, {
    status: "passed",
    evaluationStatus: "passed",
    cleanupStatus: "verified",
    terminationReason: null,
    exitCode: 0,
  });
});
test("a valid quality failure is nonzero and an invalid result can never pass", () => {
  const unsupported = {
    ...completeAnalysis,
    observed_facts: completeAnalysis.observed_facts.map((fact) => ({
      ...fact,
      claim: "El sistema presenta varios eventos.",
    })),
  };
  const failedReport = validEvaluationReport(
    candidateEvaluationReport({
      response: renderInvestigationAnalysis(unsupported),
      analysis: unsupported,
    }),
  );
  const qualityFailure = resolveEvaluationResult(
    summarizedReport(failedReport),
    1,
    true,
    null,
    null,
  );
  assert.deepEqual(qualityFailure, {
    status: "failed",
    evaluationStatus: "failed",
    cleanupStatus: "verified",
    terminationReason: null,
    exitCode: 1,
  });

  for (const [summary, exitCode] of [
    [summarizeEvaluationOutput("", evaluationGroundTruth), 0],
    [summarizedReport(), 1],
    [summarizeEvaluationOutput("truncated", evaluationGroundTruth), 7],
  ] as const) {
    assert.notEqual(
      resolveEvaluationResult(summary, exitCode, true, null, null).exitCode,
      0,
    );
  }
});

test("infrastructure failures, non-execution, interruption and cleanup failure are explicit", () => {
  assert.deepEqual(
    resolveEvaluationResult(
      summarizeEvaluationOutput("", evaluationGroundTruth),
      null,
      true,
      "database startup failed",
      null,
    ),
    {
      status: "infrastructure_error",
      evaluationStatus: "not_evaluated",
      cleanupStatus: "verified",
      terminationReason: null,
      exitCode: 1,
    },
  );
  assert.deepEqual(
    resolveEvaluationResult(summarizedReport(), 0, true, "report write failed", null),
    {
      status: "infrastructure_error",
      evaluationStatus: "passed",
      cleanupStatus: "verified",
      terminationReason: null,
      exitCode: 1,
    },
  );
  assert.deepEqual(
    resolveEvaluationResult(summarizedReport(), 0, true, null, "SIGTERM"),
    {
      status: "interrupted",
      evaluationStatus: "passed",
      cleanupStatus: "verified",
      terminationReason: "SIGTERM",
      exitCode: 130,
    },
  );
  assert.deepEqual(
    resolveEvaluationResult(summarizedReport(), 0, true, null, "timeout"),
    {
      status: "interrupted",
      evaluationStatus: "passed",
      cleanupStatus: "verified",
      terminationReason: "timeout",
      exitCode: 1,
    },
  );
  assert.deepEqual(
    resolveEvaluationResult(summarizedReport(), 0, false, null, null),
    {
      status: "cleanup_failed",
      evaluationStatus: "passed",
      cleanupStatus: "failed",
      terminationReason: null,
      exitCode: 1,
    },
  );
});

test("the first termination reason is retained when signals or timeout repeat", () => {
  assert.equal(recordTerminationReason(null, "SIGINT"), "SIGINT");
  assert.equal(recordTerminationReason("SIGINT", "SIGTERM"), "SIGINT");
  assert.equal(recordTerminationReason("timeout", "SIGTERM"), "timeout");

  const interruptedDuringCleanup = resolveEvaluationResult(
    summarizedReport(),
    0,
    false,
    "primary operation error; cleanup error",
    "SIGINT",
  );
  assert.deepEqual(interruptedDuringCleanup, {
    status: "cleanup_failed",
    evaluationStatus: "passed",
    cleanupStatus: "failed",
    terminationReason: "SIGINT",
    exitCode: 130,
  });
});

test("runner signal handlers preserve the first interrupt and stop later startup work", async () => {
  const signals = new EventEmitter();
  const termination = new TerminationController();
  const unregister = registerTerminationHandlers(
    (signal, listener) => {
      signals.on(signal, listener);
    },
    (signal, listener) => {
      signals.off(signal, listener);
    },
    termination,
  );
  const operations: string[] = [];

  const startup = async (): Promise<void> => {
    operations.push("current-stage");
    signals.emit("SIGINT");
    termination.throwIfTerminated("test runner");
    operations.push("next-stage");
  };

  try {
    await assert.rejects(startup(), /interrupted by SIGINT/u);
    signals.emit("SIGTERM");
    assert.equal(await termination.interrupted, "SIGINT");
    assert.equal(termination.reason, "SIGINT");
    assert.deepEqual(operations, ["current-stage"]);
  } finally {
    unregister();
  }
});
