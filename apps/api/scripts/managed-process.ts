import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { redactSecrets } from "./inc001-isolated-lib.js";
import {
  classifyProcessStop,
  type ProcessStopState,
} from "./inc001-runner-lifecycle.js";

export interface ManagedChild {
  pid: number | undefined;
  onStdoutData(listener: (chunk: Buffer) => void): void;
  onStderrData(listener: (chunk: Buffer) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface ManagedProcessRuntime {
  platform: NodeJS.Platform;
  spawnChild(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
  ): ManagedChild;
  taskkill(pid: number): { status: number | null; errorCode?: string };
  inspectWindowsDescendants(pid: number): number[] | null;
  killProcessGroup(pid: number, signal: NodeJS.Signals | 0): void;
  wait(milliseconds: number): Promise<void>;
}

function adaptChild(child: ChildProcess): ManagedChild {
  return {
    pid: child.pid,
    onStdoutData(listener) {
      child.stdout?.on("data", listener);
    },
    onStderrData(listener) {
      child.stderr?.on("data", listener);
    },
    onError(listener) {
      child.once("error", listener);
    },
    onExit(listener) {
      child.once("exit", listener);
    },
    onClose(listener) {
      child.once("close", listener);
    },
  };
}

function inspectWindowsDescendants(pid: number): number[] | null {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=${pid}`,
    "try { $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) } catch { exit 1 }",
    "$known=New-Object 'System.Collections.Generic.HashSet[int]'",
    "[void]$known.Add($root)",
    "$desc=@()",
    "do { $added=$false; foreach($p in $all) { $procId=[int]$p.ProcessId; if($known.Contains([int]$p.ParentProcessId) -and -not $known.Contains($procId)) { [void]$known.Add($procId); $desc+=,$procId; $added=$true } } } while($added)",
    "ConvertTo-Json -InputObject @($desc) -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5_000,
    },
  );
  if (result.status !== 0 || result.error) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.every(
      (value) => Number.isInteger(value) && Number(value) > 0,
    )
      ? (values as number[])
      : null;
  } catch {
    return null;
  }
}

const defaultRuntime: ManagedProcessRuntime = {
  platform: process.platform,
  spawnChild(command, args, options) {
    return adaptChild(
      spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: options.detached,
      }),
    );
  },
  taskkill(pid) {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 8_000,
      },
    );
    return {
      status: result.status,
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    };
  },
  inspectWindowsDescendants,
  killProcessGroup(pid, signal) {
    process.kill(pid, signal);
  },
  wait: delay,
};

export class ManagedProcess {
  exitCode: number | null | undefined;
  private readonly child: ManagedChild;
  private readonly stdoutChunks: string[] = [];
  private readonly stderrChunks: string[] = [];
  private size = 0;
  private stopPromise: Promise<ProcessStopState> | null = null;
  readonly exited: Promise<number | null>;

  constructor(
    readonly label: string,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    private readonly secrets: string[],
    private readonly runtime: ManagedProcessRuntime = defaultRuntime,
  ) {
    this.child = runtime.spawnChild(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: runtime.platform !== "win32",
    });
    const capture = (target: string[]) => (chunk: Buffer) => {
      if (this.size < 2_000_000) {
        this.size += chunk.length;
        target.push(chunk.toString("utf8"));
      }
    };
    this.child.onStdoutData(capture(this.stdoutChunks));
    this.child.onStderrData(capture(this.stderrChunks));
    this.exited = new Promise((resolveExit) => {
      this.child.onError((error) => {
        this.stderrChunks.push(`spawn error: ${error.message}\n`);
        this.exitCode = -1;
      });
      this.child.onExit((code, signal) => {
        this.exitCode = code ?? (signal ? -1 : null);
      });
      this.child.onClose((code, signal) => {
        this.exitCode ??= code ?? (signal ? -1 : null);
        resolveExit(this.exitCode);
      });
    });
  }

  get stdout(): string {
    return redactSecrets(this.stdoutChunks.join(""), this.secrets);
  }

  get stderr(): string {
    return redactSecrets(this.stderrChunks.join(""), this.secrets);
  }

  stop(): Promise<ProcessStopState> {
    this.stopPromise ??= this.stopProcess();
    return this.stopPromise;
  }

  private async stopProcess(): Promise<ProcessStopState> {
    const pid = this.child.pid;
    if (pid === undefined) {
      return "unknown";
    }

    if (this.runtime.platform === "win32") {
      if (this.exitCode !== undefined) {
        const processClosed = await Promise.race([
          this.exited.then(() => true),
          this.runtime.wait(8_000).then(() => false),
        ]);
        if (!processClosed) {
          return "unknown";
        }
        const descendants = this.runtime.inspectWindowsDescendants(pid);
        return descendants === null
          ? "unknown"
          : descendants.length === 0
            ? "stopped"
            : "failed";
      }
      const taskkill = this.runtime.taskkill(pid);
      const processClosed = await Promise.race([
        this.exited.then(() => true),
        this.runtime.wait(8_000).then(() => false),
      ]);
      if (taskkill.errorCode === "ETIMEDOUT" || !processClosed) {
        return "unknown";
      }
      const descendants = this.runtime.inspectWindowsDescendants(pid);
      if (descendants === null) {
        return "unknown";
      }
      if (descendants.length > 0) {
        return taskkill.status === 0 ? "failed" : "unknown";
      }
      return classifyProcessStop(taskkill.status, processClosed, false);
    }

    try {
      this.runtime.killProcessGroup(-pid, "SIGTERM");
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        return "failed";
      }
    }
    let processClosed = await Promise.race([
      this.exited.then(() => true),
      this.runtime.wait(8_000).then(() => false),
    ]);
    try {
      this.runtime.killProcessGroup(-pid, 0);
      this.runtime.killProcessGroup(-pid, "SIGKILL");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return processClosed ? "stopped" : "unknown";
      }
      return "unknown";
    }
    processClosed =
      processClosed ||
      (await Promise.race([
        this.exited.then(() => true),
        this.runtime.wait(3_000).then(() => false),
      ]));
    try {
      this.runtime.killProcessGroup(-pid, 0);
      return "unknown";
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return processClosed ? "stopped" : "unknown";
      }
      return "unknown";
    }
  }
}
