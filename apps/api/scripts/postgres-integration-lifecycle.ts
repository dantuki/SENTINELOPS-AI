import {
  HABITUAL_VOLUME_NAME,
  POSTGRES_IMAGE_VOLUME_PATH,
} from "./inc001-isolated-lib.js";
import {
  classifyDockerInspect,
  resolveContainerCandidate,
  type CommandResult,
} from "./inc001-runner-lifecycle.js";

export const POSTGRES_INTEGRATION_RUNNER_LABEL =
  "com.sentinelops.runner";
export const POSTGRES_INTEGRATION_RUNNER_VALUE = "postgres-integration";
export const POSTGRES_INTEGRATION_RUN_ID_LABEL = "com.sentinelops.run-id";
const ANONYMOUS_VOLUME_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CONTAINER_PATTERN = /^sentinelops-postgres-integration-[0-9a-f]{32}$/u;

export interface TemporaryPostgresIdentity {
  id: string;
  name: string;
  runId: string;
  image: string;
  port?: number;
}

export type DockerExecutor = (args: string[]) => CommandResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildPostgresContainerArgs(options: {
  name: string;
  runId: string;
  cidfile: string;
  image: string;
  database: string;
  user: string;
}): string[] {
  if (!CONTAINER_PATTERN.test(options.name) || !RUN_ID_PATTERN.test(options.runId)) {
    throw new Error("Temporary PostgreSQL container identity is invalid.");
  }
  return [
    "run",
    "--detach",
    "--rm",
    "--cidfile",
    options.cidfile,
    "--name",
    options.name,
    "--label",
    `${POSTGRES_INTEGRATION_RUNNER_LABEL}=${POSTGRES_INTEGRATION_RUNNER_VALUE}`,
    "--label",
    `${POSTGRES_INTEGRATION_RUN_ID_LABEL}=${options.runId}`,
    "--env",
    `POSTGRES_DB=${options.database}`,
    "--env",
    `POSTGRES_USER=${options.user}`,
    "--env",
    "POSTGRES_PASSWORD",
    "--publish",
    "127.0.0.1::5432",
    options.image,
  ];
}

export function assertPostgresContainerIdentity(
  inspected: unknown,
  expected: TemporaryPostgresIdentity,
): string {
  const entry = Array.isArray(inspected) ? inspected[0] : inspected;
  if (!isRecord(entry)) {
    throw new Error("Docker inspect returned an unexpected container shape.");
  }
  if (
    typeof entry.Id !== "string" ||
    !entry.Id.startsWith(expected.id) ||
    entry.Name !== `/${expected.name}`
  ) {
    throw new Error("The inspected container is not the temporary PostgreSQL instance.");
  }
  const config = entry.Config;
  if (!isRecord(config) || config.Image !== expected.image) {
    throw new Error("The temporary PostgreSQL container uses an unexpected image.");
  }
  const labels = config.Labels;
  if (
    !isRecord(labels) ||
    labels[POSTGRES_INTEGRATION_RUNNER_LABEL] !==
      POSTGRES_INTEGRATION_RUNNER_VALUE ||
    labels[POSTGRES_INTEGRATION_RUN_ID_LABEL] !== expected.runId
  ) {
    throw new Error("The temporary PostgreSQL container ownership labels do not match.");
  }

  const hostConfig = entry.HostConfig;
  if (!isRecord(hostConfig) || hostConfig.AutoRemove !== true) {
    throw new Error("The temporary PostgreSQL container must use --rm.");
  }
  const binds = hostConfig.Binds;
  if (Array.isArray(binds) && binds.length > 0) {
    throw new Error("The temporary PostgreSQL container must not use bind mounts.");
  }
  const bindings = hostConfig.PortBindings;
  const published = isRecord(bindings) ? bindings["5432/tcp"] : undefined;
  const network = entry.NetworkSettings;
  const ports = isRecord(network) ? network.Ports : undefined;
  const actual = isRecord(ports) ? ports["5432/tcp"] : undefined;
  if (
    !Array.isArray(published) ||
    published.length !== 1 ||
    !isRecord(published[0]) ||
    published[0].HostIp !== "127.0.0.1" ||
    !Array.isArray(actual) ||
    actual.length !== 1 ||
    !isRecord(actual[0]) ||
    actual[0].HostIp !== "127.0.0.1" ||
    !/^\d+$/u.test(String(actual[0].HostPort)) ||
    (published[0].HostPort !== "" &&
      published[0].HostPort !== "0" &&
      published[0].HostPort !== actual[0].HostPort) ||
    (expected.port !== undefined &&
      actual[0].HostPort !== String(expected.port))
  ) {
    throw new Error("PostgreSQL must be published on one dynamically assigned loopback port.");
  }

  const mounts = entry.Mounts;
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    !isRecord(mounts[0]) ||
    mounts[0].Type !== "volume" ||
    typeof mounts[0].Name !== "string" ||
    !ANONYMOUS_VOLUME_PATTERN.test(mounts[0].Name) ||
    mounts[0].Name === HABITUAL_VOLUME_NAME ||
    mounts[0].Destination !== POSTGRES_IMAGE_VOLUME_PATH
  ) {
    throw new Error("The temporary PostgreSQL container must use only its anonymous data volume.");
  }
  return mounts[0].Name;
}

export interface PostgresCleanupResult {
  success: boolean;
  container: "removed" | "present" | "not_created" | "unknown";
  volume: "removed" | "present" | "not_created" | "unknown";
  volumeName: string | null;
  errors: string[];
}

function isNoSuchObject(result: CommandResult): boolean {
  return classifyDockerInspect(result) === "ABSENT";
}

export function cleanupTemporaryPostgresContainer(options: {
  containerName: string;
  runId: string;
  image: string;
  cidfile: string | null;
  runDocker: DockerExecutor;
}): PostgresCleanupResult {
  const result: PostgresCleanupResult = {
    success: false,
    container: "unknown",
    volume: "unknown",
    volumeName: null,
    errors: [],
  };
  const candidates = options.runDocker([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=${POSTGRES_INTEGRATION_RUNNER_LABEL}=${POSTGRES_INTEGRATION_RUNNER_VALUE}`,
    "--filter",
    `label=${POSTGRES_INTEGRATION_RUN_ID_LABEL}=${options.runId}`,
  ]);
  const cidfile = options.cidfile && /^[0-9a-f]{12,64}$/iu.test(options.cidfile.trim())
    ? options.cidfile
    : null;
  const candidate = resolveContainerCandidate(cidfile, candidates);
  if (candidate.state === "unknown") {
    result.errors.push("Could not identify the temporary PostgreSQL container safely.");
    return result;
  }
  if (candidate.state === "absent") {
    const byName = options.runDocker(["inspect", options.containerName]);
    if (isNoSuchObject(byName)) {
      result.container = "not_created";
      result.volume = "not_created";
      result.success = true;
      return result;
    }
    result.errors.push("A container with the temporary name could not be verified as absent.");
    return result;
  }

  const inspect = options.runDocker(["inspect", candidate.id]);
  if (inspect.status !== 0) {
    if (isNoSuchObject(inspect)) {
      result.container = "removed";
      result.volume = "unknown";
      result.errors.push("The container disappeared before its anonymous volume could be verified.");
    } else {
      result.errors.push("Could not inspect the temporary PostgreSQL container.");
    }
    return result;
  }

  try {
    result.volumeName = assertPostgresContainerIdentity(
      JSON.parse(inspect.stdout),
      {
        id: candidate.id,
        name: options.containerName,
        runId: options.runId,
        image: options.image,
      },
    );
  } catch (error: unknown) {
    result.errors.push(
      error instanceof Error ? error.message : "Temporary container identity was invalid.",
    );
    return result;
  }

  options.runDocker(["rm", "--force", "--volumes", candidate.id]);
  const after = options.runDocker(["inspect", candidate.id]);
  const afterState = classifyDockerInspect(after);
  if (afterState !== "ABSENT") {
    if (afterState === "PRESENT") {
      result.container = "present";
      result.volume = "present";
    }
    result.errors.push("Temporary PostgreSQL container removal could not be verified.");
    return result;
  }
  result.container = "removed";

  const volumeName = result.volumeName;
  if (volumeName === null) {
    result.errors.push("Temporary PostgreSQL volume identity was not recorded.");
    return result;
  }
  const volumeInspect = options.runDocker(["volume", "inspect", volumeName]);
  const volumeState = classifyDockerInspect(volumeInspect);
  if (volumeState === "PRESENT") {
    let inspectedVolume: unknown;
    try {
      inspectedVolume = JSON.parse(volumeInspect.stdout);
    } catch {
      result.errors.push("Temporary PostgreSQL volume identity could not be verified.");
      return result;
    }
    const entry = Array.isArray(inspectedVolume)
      ? inspectedVolume[0]
      : inspectedVolume;
    if (
      isRecord(entry) &&
      entry.Name === volumeName &&
      ANONYMOUS_VOLUME_PATTERN.test(volumeName) &&
      volumeName !== HABITUAL_VOLUME_NAME
    ) {
      result.volume = "present";
      result.errors.push(
        `Temporary PostgreSQL anonymous volume remains: ${volumeName} at ${POSTGRES_IMAGE_VOLUME_PATH}.`,
      );
    } else {
      result.errors.push("Temporary PostgreSQL volume identity could not be verified.");
    }
    return result;
  }
  if (volumeState !== "ABSENT") {
    result.errors.push("Temporary PostgreSQL anonymous volume removal could not be verified.");
    return result;
  }
  result.volume = "removed";
  result.success = result.errors.length === 0;
  return result;
}
