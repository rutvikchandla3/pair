import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ProviderInstanceId,
  type ProviderSetupError,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveSpawnCommand, type SpawnCommandOptions } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "../provider/codexLaunchArgs.ts";
import type { CodexEffectiveRuntime } from "../provider/CodexManagedRuntime.ts";
import { codexAppServerEnvironment } from "../provider/CodexProvider.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  codexModelFamily,
  getModelSelectionStringOptionValue,
  readCustomModelEntries,
} from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import type { WorkspaceHost } from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import { makeSandboxTempDirectory } from "../sandbox/providers/SandboxProviderHome.ts";
import { makeMachineInvestigationFor } from "./machineInvestigation.ts";

const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
// Codex also reads the legacy connectors key for apps.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.connectors=false",
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
// A cloud-only server is not the agent's to read: no shell, and no image reads by path.
const CODEX_NO_TOOL_ARGS = [
  "--config",
  "features.shell_tool=false",
  "--config",
  "features.unified_exec=false",
  "--config",
  "features.view_image=false",
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

// mcp_servers={} merges instead of replacing; disable named entries and quote dotted names.
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
// Codex splits -c keys at the first "=" and on every dot, so only those names take a dotted flag.
const codexMcpServerOffFlags = (names: ReadonlyArray<string>) =>
  names
    .filter((name) => !name.includes(".") && !name.includes("="))
    .flatMap((name) => ["--config", `mcp_servers.${name}.enabled=false`]);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  instanceId: ProviderInstanceId,
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  /** Managed Codex's runtime on a host: its token forward in a machine (`resolveFor`). */
  resolveRuntimeFor?: (
    host: WorkspaceHost,
  ) => Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>,
) {
  // oxlint-disable-next-line t3code/workspace-host-boundary -- server-scoped: image attachments, which only titles send
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const machineInvestigationFor = yield* makeMachineInvestigationFor;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly spawner: WorkspaceHost["spawner"];
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
      readonly facts: SpawnCommandOptions["facts"];
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env, ...(input.facts === undefined ? {} : { facts: input.facts }) },
      );
      const child = yield* input.spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    // Text in, text out, so a cloud thread's request runs here too: in its machine it would carry
    // the server's env. An investigation reads the checkout, so it runs where the checkout is.
    const machine =
      investigate === undefined
        ? undefined
        : yield* machineInvestigationFor({
            operation,
            cwd,
            instanceId,
            homeVariable: "CODEX_HOME",
          });
    const host = machine?.host ?? hosts.local;
    const cwdOnServer =
      machine === undefined &&
      (yield* hosts.forPath(cwd).pipe(
        Effect.map((cwdHost) => cwdHost.kind === "local"),
        Effect.orElseSucceed(() => false),
      ));
    const tempDirFailed = (cause: unknown) =>
      new TextGenerationError({ operation, detail: "Failed to write temp file", cause });
    // Unscoped: background fibers may inherit closed scopes that would reap the files on creation.
    // In a machine the agent writes the output file, so the agent makes the directory.
    const tempDir = yield* (
      machine === undefined
        ? host.fileSystem.makeTempDirectory({ prefix: `t3code-codex-${process.pid}-` })
        : makeSandboxTempDirectory(host, "t3code-codex-")
    ).pipe(Effect.mapError(tempDirFailed));
    const cleanup = host.fileSystem.remove(tempDir, { recursive: true }).pipe(Effect.ignore);
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    const workingDirectory = machine !== undefined || cwdOnServer ? cwd : tempDir;

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      yield* host.fileSystem
        .writeFileString(schemaPath, schemaJson)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({ operation, detail: "Failed to write temp file", cause }),
          ),
        );
      const hostInfo = yield* host.info;
      const resolved = resolveRuntimeFor
        ? yield* resolveRuntimeFor(host).pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment =
        machine?.environment ?? resolved?.environment ?? environment ?? hostInfo.environment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const listed = models.filter((candidate) => !candidate.isCustom);
      // An unlisted slug is one this account can't run, e.g. gpt-6-luna on a ChatGPT login.
      const requestedFamily = codexModelFamily(requestedModel);
      const matchedModel =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        // Managed snapshots omit configured custom models; send those as requested.
        readCustomModelEntries(codexConfig.customModels).find(
          (entry) => entry.slug === requestedModel,
        )?.slug ??
        listed.find((candidate) => codexModelFamily(candidate.slug) === requestedFamily)?.slug;
      const model =
        matchedModel ??
        listed.find((candidate) => candidate.isDefault)?.slug ??
        listed.find((candidate) => !candidate.isLegacy)?.slug ??
        listed[0]?.slug ??
        requestedModel;
      // The selection's options were chosen for the requested model and may not fit a fallback.
      const fellBack = matchedModel === undefined && model !== requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        (fellBack
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier =
        resolved || fellBack ? undefined : getCodexServiceTierOptionValue(modelSelection);
      // A machine runs the image's pinned codex on its own home, never this server's.
      const binary = machine === undefined ? effectiveConfig.binaryPath || "codex" : "codex";
      const env = codexAppServerEnvironment(
        machine?.environment ??
          ({
            ...effectiveEnvironment,
            ...(effectiveConfig.homePath
              ? {
                  CODEX_HOME: expandHomePath(effectiveConfig.homePath, hostInfo.homeDirectory),
                }
              : {}),
          } satisfies NodeJS.ProcessEnv),
      );
      const facts =
        machine === undefined ? undefined : { platform: hostInfo.platform, environment: env };
      const enabledMcpServers = yield* listEnabledMcpServers({
        spawner: host.spawner,
        binary,
        cwd: workingDirectory,
        env,
        facts,
        launchArgs: codexMcpListLaunchArgs(launchArgs),
      });
      const mcpServersOff = codexMcpServersOff(enabledMcpServers);
      const execLaunchArgs = codexExecLaunchArgs(launchArgs);
      // A launch-arg mcp_servers={...} table replaces ours and can re-enable dotted names.
      const launchArgsSetMcpTable = execLaunchArgs.some((arg) => /\bmcp_servers\s*=/.test(arg));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          // Before launch args: a later table would replace servers their -c flags define.
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          ...execLaunchArgs,
          // A user's MCP server could act on the text-generation prompt.
          ...CODEX_NO_PLUGIN_ARGS,
          ...(serverConfig.cloudOnly && investigate === undefined ? CODEX_NO_TOOL_ARGS : []),
          ...(mcpServersOff && launchArgsSetMcpTable ? ["--config", mcpServersOff] : []),
          // After launch args, so a launch arg's enabled=true cannot turn a server back on.
          ...codexMcpServerOffFlags(enabledMcpServers),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          // Current Codex gives hooks precedence over the historical codex_hooks alias.
          "--config",
          "features.codex_hooks=false",
          "--config",
          "features.hooks=false",
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment, ...(facts === undefined ? {} : { facts }) },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* host.spawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* host.fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  return TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson);
});
