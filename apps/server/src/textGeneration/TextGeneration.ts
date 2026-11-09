import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import { providerInstanceOwner } from "@t3tools/shared/providerInstanceOwnership";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.filterOrFail(
      (instance) => instance !== undefined,
      () =>
        new TextGenerationError({
          operation,
          detail: `No provider instance registered for id '${instanceId}'.`,
        }),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);
// On cloud-only text generation runs on the server, so only drivers whose tools turn off may run it.
const TOOL_FREE_DRIVERS = new Set(["codex", "claudeAgent"]);

const canGenerate = (provider: ServerProvider | undefined) =>
  provider?.enabled === true &&
  provider.installed &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider) &&
  isProviderTextGenerationCapable(provider);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;

  /**
   * On cloud-only, a server-side `cwd` is swapped for an empty one: the server's folders are not
   * the agent's. An investigation needs the checkout itself, so it runs only inside a machine.
   */
  const confinedCwd = Effect.fn("TextGeneration.confinedCwd")(function* (
    operation: TextGenerationOp,
    cwd: string,
  ) {
    if (!cloudOnly) return cwd;
    const onServer = yield* hosts.forPath(cwd).pipe(
      Effect.map((host) => host.kind === "local"),
      Effect.orElseSucceed(() => false),
    );
    if (!onServer) return cwd;
    if (operation === "generateReviewGuide") {
      return yield* new TextGenerationError({
        operation,
        detail: "This server investigates a checkout only inside its machine.",
      });
    }
    return yield* hosts.local.fileSystem.makeTempDirectoryScoped({ prefix: "t3code-text-" }).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not create an empty working directory.",
            cause,
          }),
      ),
    );
  });

  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    cwd: string,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
      cwd: string,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const workingDirectory = yield* confinedCwd(operation, cwd);
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    const limited = exhaustedUsageWindow(selected, now, selection.model);
    if (limited || (cloudOnly && !canGenerate(selected))) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      selection =
        fallbackTextGenerationModelSelection(
          settings.providerInstances,
          (instanceId, driver) => {
            const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
            return (
              instanceId !== selection.instanceId &&
              canGenerate(provider) &&
              resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
              // A member's own account is theirs to pick; it never writes text for others.
              providerInstanceOwner(settings, instanceId) === undefined &&
              (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
              (!cloudOnly || TOOL_FREE_DRIVERS.has(driver)) &&
              !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
            );
          },
          { includeConfiguredInstances: true },
        ) ?? selection;
    }
    const instance = yield* resolveInstance(registry, operation, selection.instanceId);
    if (cloudOnly && !TOOL_FREE_DRIVERS.has(instance.driverKind)) {
      return yield* new TextGenerationError({
        operation,
        detail: `${instance.displayName ?? instance.driverKind} can't write commit messages, titles or PR text on this server: only Claude and Codex run here with their tools off.`,
      });
    }
    return yield* invoke(instance.textGeneration, selection, workingDirectory);
  }, Effect.scoped);
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.cwd,
        (service, modelSelection, cwd) =>
          service.generateCommitMessage({ ...input, modelSelection, cwd }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.cwd,
        (service, modelSelection, cwd) =>
          service.generatePrContent({ ...input, modelSelection, cwd }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.cwd,
        (service, modelSelection, cwd) =>
          service.generateBranchName({ ...input, modelSelection, cwd }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.cwd,
        (service, modelSelection, cwd) =>
          service.generateReviewGuide({ ...input, modelSelection, cwd }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        input.cwd,
        (textGeneration, modelSelection, cwd) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              cwd,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
