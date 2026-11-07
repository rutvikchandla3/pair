import type { ResourceMonitorProcessTableEntry } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import type { WorkspaceHost } from "../workspaceHost/WorkspaceHost.ts";

export class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor", "workspace-host"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

function parsePosixProcessTable(stdout: string): Array<ResourceMonitorProcessTableEntry> {
  const entries: Array<ResourceMonitorProcessTableEntry> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    // The final comm column can contain spaces; only the first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    entries.push({ pid, ppid, name: (match[3] ?? "").trim() });
  }
  return entries;
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve ps once; bare-name spawns repeatedly probe long PATHs during one-second polling.
export const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* (
  host: WorkspaceHost,
) {
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* host.fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

export const readPosixProcessTable = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  host: WorkspaceHost,
  psCommand: string,
  timeout: Duration.Input,
): Effect.fn.Return<
  Array<ResourceMonitorProcessTableEntry>,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      host,
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout,
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Reject partial tables; treating them as authoritative would clear process ids and mark terminals idle.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});
