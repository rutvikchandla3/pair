import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

export class ProviderCredentialError extends Schema.TaggedError<ProviderCredentialError>()(
  "ProviderCredentialError",
  {
    operation: Schema.Literals(["get", "set", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} stored provider credentials.`;
  }
}

export class ProviderSessionHostUnavailableError extends Schema.TaggedError<ProviderSessionHostUnavailableError>()(
  "ProviderSessionHostUnavailableError",
  /** `detail`: the machine is connected but a process cannot start there, such as an unread secret. */
  { sandboxId: Schema.String, detail: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    return this.detail ?? "This thread's machine is not connected.";
  }
}
