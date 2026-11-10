export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
}

export type DockerResourceState =
  | "PRESENT"
  | "ABSENT"
  | "DAEMON_UNAVAILABLE"
  | "TIMEOUT"
  | "UNKNOWN";

export function classifyDockerInspect(
  result: CommandResult,
): DockerResourceState {
  if (result.timedOut || result.errorCode === "ETIMEDOUT") {
    return "TIMEOUT";
  }
  if (result.status === 0) {
    try {
      const inspected: unknown = JSON.parse(result.stdout);
      const entry = Array.isArray(inspected) ? inspected[0] : inspected;
      if (
        typeof entry === "object" &&
        entry !== null &&
        ("Id" in entry || "Name" in entry)
      ) {
        return "PRESENT";
      }
    } catch {
      return "UNKNOWN";
    }
    return "UNKNOWN";
  }

  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    /no such (?:object|container|volume):/u.test(message) ||
    /^error response from daemon: get [^\r\n:]+: no such volume\s*$/mu.test(
      message,
    )
  ) {
    return "ABSENT";
  }
  if (
    /cannot connect to the docker daemon|error during connect|docker daemon is not running|pipe.*not found|daemon.*unavailable/u.test(
      message,
    )
  ) {
    return "DAEMON_UNAVAILABLE";
  }
  return "UNKNOWN";
}

export type ProcessStopState = "stopped" | "failed" | "unknown";

export type EvaluationStage =
  | "arguments"
  | "warmup"
  | "readiness"
  | "authentication"
  | "ingestion"
  | "investigation"
  | "evaluation";

export type TerminationReason = "SIGINT" | "SIGTERM" | "timeout";

export function recordTerminationReason(
  current: TerminationReason | null,
  next: TerminationReason,
): TerminationReason {
  return current ?? next;
}

export type TerminationSignal = "SIGINT" | "SIGTERM";
export type TerminationSignalListener = () => void;
export type TerminationSignalSubscribe = (
  signal: TerminationSignal,
  listener: TerminationSignalListener,
) => void;

export class TerminationController {
  private currentReason: TerminationReason | null = null;
  private resolveInterrupted!: (reason: TerminationReason) => void;
  readonly interrupted = new Promise<TerminationReason>((resolve) => {
    this.resolveInterrupted = resolve;
  });

  get reason(): TerminationReason | null {
    return this.currentReason;
  }

  record(reason: TerminationReason): void {
    if (this.currentReason !== null) {
      return;
    }
    this.currentReason = reason;
    this.resolveInterrupted(reason);
  }

  throwIfTerminated(context: string): void {
    if (this.currentReason !== null) {
      throw new Error(`${context} interrupted by ${this.currentReason}.`);
    }
  }
}

export function registerTerminationHandlers(
  subscribe: TerminationSignalSubscribe,
  unsubscribe: TerminationSignalSubscribe,
  controller: TerminationController,
): () => void {
  const onSigint = (): void => controller.record("SIGINT");
  const onSigterm = (): void => controller.record("SIGTERM");
  subscribe("SIGINT", onSigint);
  subscribe("SIGTERM", onSigterm);
  return () => {
    unsubscribe("SIGINT", onSigint);
    unsubscribe("SIGTERM", onSigterm);
  };
}

const evaluationStages: EvaluationStage[] = [
  "arguments",
  "warmup",
  "readiness",
  "authentication",
  "ingestion",
  "investigation",
  "evaluation",
];

export function parseEvaluationFailureStage(
  stderr: string,
): EvaluationStage | null {
  const match =
    /INC-001 evaluation failed \[stage=(arguments|warmup|readiness|authentication|ingestion|investigation|evaluation)\]:/u.exec(
      stderr,
    );
  return (
    evaluationStages.find((stage) => stage === match?.[1]) ?? null
  );
}

export type CleanupResourceState =
  | "removed"
  | "present"
  | "unknown"
  | "failed"
  | "not_created";

export function resolveContainerCandidate(
  cidfile: string | null,
  candidates: CommandResult,
):
  | { state: "candidate"; id: string }
  | { state: "absent" }
  | { state: "unknown" } {
  if (cidfile !== null) {
    const id = cidfile.trim();
    return /^[0-9a-f]{12,64}$/iu.test(id)
      ? { state: "candidate", id }
      : { state: "unknown" };
  }
  if (candidates.status !== 0) {
    return { state: "unknown" };
  }
  const ids = candidates.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return { state: "absent" };
  }
  if (
    ids.length !== 1 ||
    !/^[0-9a-f]{12,64}$/iu.test(ids[0]!)
  ) {
    return { state: "unknown" };
  }
  return { state: "candidate", id: ids[0]! };
}

export function classifyContainerCleanup(
  inspectState: DockerResourceState,
): "removed" | "present" | "unknown" {
  if (inspectState === "ABSENT") {
    return "removed";
  }
  if (inspectState === "PRESENT") {
    return "present";
  }
  return "unknown";
}

export function classifyVolumeCleanup(
  inspectState: DockerResourceState,
  identityMatches: boolean,
): "removed" | "present" | "unknown" {
  if (inspectState === "ABSENT") {
    return "removed";
  }
  if (inspectState === "PRESENT" && identityMatches) {
    return "present";
  }
  return "unknown";
}

export function cleanupIsVerified(report: {
  processes: Record<string, ProcessStopState | "not_started">;
  container: { state: CleanupResourceState; verified: boolean };
  volume: { state: CleanupResourceState; verified: boolean };
  errors: string[];
}): boolean {
  return (
    Object.values(report.processes).every(
      (state) => state === "stopped" || state === "not_started",
    ) &&
    (report.container.state === "removed" ||
      report.container.state === "not_created") &&
    report.container.verified &&
    (report.volume.state === "removed" || report.volume.state === "not_created") &&
    report.volume.verified &&
    report.errors.length === 0
  );
}

export function classifyProcessStop(
  taskkillStatus: number | null,
  processClosed: boolean,
  timedOut: boolean,
): ProcessStopState {
  if (timedOut) {
    return "unknown";
  }
  if (taskkillStatus === 0 && processClosed) {
    return "stopped";
  }
  if (taskkillStatus !== null && taskkillStatus !== 0 && processClosed) {
    return "unknown";
  }
  return "failed";
}
