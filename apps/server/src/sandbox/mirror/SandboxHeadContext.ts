import * as Schema from "effect/Schema";

/** What PR discovery reads from a checkout, saved with the sleep snapshot (07 §3). */
export const SandboxHeadContext = Schema.Struct({
  version: Schema.Literal(1),
  capturedAt: Schema.DateTimeUtcFromString,
  branch: Schema.String,
  headOid: Schema.String,
  upstream: Schema.NullOr(Schema.Struct({ remoteName: Schema.String, remoteRef: Schema.String })),
  remotes: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  defaultBranch: Schema.NullOr(Schema.String),
});
export type SandboxHeadContext = typeof SandboxHeadContext.Type;

export const SandboxHeadContextJson = Schema.fromJsonString(SandboxHeadContext);
