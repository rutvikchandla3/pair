import * as Schema from "effect/Schema";

export class ProviderInstanceNotFoundError extends Schema.TaggedError<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

export { ProviderDriverError } from "@t3tools/provider-core/server/errors";

/** Raised before any adapter code runs for a provider that cannot run in a sandbox yet. */
export class ProviderCloudUnsupportedError extends Schema.TaggedError<ProviderCloudUnsupportedError>()(
  "ProviderCloudUnsupportedError",
  {
    threadId: Schema.String,
    driver: Schema.String,
  },
) {
  override get message(): string {
    return `${this.driver} is not supported in cloud yet. Pick Claude or Codex.`;
  }
}

/** Raised before any sandbox process starts for an account with no headless credential (06 §3). */
export class ProviderCloudLocalOnlyError extends Schema.TaggedError<ProviderCloudLocalOnlyError>()(
  "ProviderCloudLocalOnlyError",
  {
    threadId: Schema.optional(Schema.String),
    instanceId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ProviderWorkspaceMissingError extends Schema.TaggedError<ProviderWorkspaceMissingError>()(
  "ProviderWorkspaceMissingError",
  {
    threadId: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}
