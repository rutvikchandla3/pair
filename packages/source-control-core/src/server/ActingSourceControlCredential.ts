import type { SourceControlProviderKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Redacted from "effect/Redacted";

export interface ActingCredential {
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
}

/**
 * A person's own forge credential for the requests run under it. Providers use it strictly: a
 * host mismatch is an authentication failure, never a fall back to the server's credential.
 */
export const ActingSourceControlCredential = Context.Reference<ActingCredential | null>(
  "@t3tools/source-control-core/server/ActingSourceControlCredential",
  { defaultValue: () => null },
);
