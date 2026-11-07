import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  resolveSettings,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      agentId: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
      cwd: Schema.optionalKey(Schema.String),
      settingSources: Schema.optionalKey(
        Schema.Array(Schema.Literals(["user", "project", "local"])),
      ),
      serverManagedSettings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

/** `resolveSettings` reads no session: its session id is `-`. It prints only `effective`. */
export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const { agentId, cwd, settingSources, serverManagedSettings, ...options } = decodeHistoryOptions(
    rawOptions ?? "{}",
  );
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkSession(sessionId, options).then(async (forked) => {
            const headMessageId = await getSessionMessages(forked.sessionId, options)
              .then((messages) => messages.at(-1)?.uuid)
              .catch(() => undefined);
            return headMessageId === undefined ? forked : { ...forked, headMessageId };
          })
        : method === "getSubagentMessages" && agentId !== undefined
          ? await getSubagentMessages(sessionId, agentId, options)
          : method === "resolveSettings"
            ? await resolveSettings({
                ...(cwd === undefined ? {} : { cwd }),
                ...(settingSources === undefined ? {} : { settingSources: [...settingSources] }),
                ...(serverManagedSettings === undefined ? {} : { serverManagedSettings }),
              }).then((resolved) => resolved.effective)
            : (() => {
                throw new Error("Unknown Claude history operation.");
              })();
  process.stdout.write(JSON.stringify(result));
}
