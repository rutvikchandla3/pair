import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * A peer's `/mcp` holds a wait open for its whole timeout without sending
 * anything, and T3 Connect's edge drops a request idle for about 100 s, so a
 * forwarded wait goes out in pieces no longer than this.
 */
export const FORWARDED_WAIT_CHUNK_MS = 50_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route, and a
     * `t3_thread_launch` naming no project goes to the one there with the
     * calling thread's repository.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, in pieces short enough to survive any route. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /**
     * The project in `environmentId` with the repository of the project here
     * that `parentProjectId` names, or `requested` when the caller named one.
     * `argument` is what the caller passes to name one, for the message.
     */
    readonly resolveProject: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: {
        readonly parentProjectId: ProjectId;
        readonly requested: ProjectId | undefined;
        readonly argument: "projectId" | "target.projectId";
      },
    ) => Effect.Effect<ProjectId, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** What an agent hears when it names another machine while the beta is off here. */
export const linkedEnvironmentsOff = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.",
});

/** What an agent hears when it names a machine other than its Pair Cloud while the beta is off here. */
const onlyAgentLinks = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine; only its Pair Cloud link works without it. The user can turn it on in Settings → Labs.",
});

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Digest.Digest;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  /**
   * The caller's own limits, which travel with every forwarded call: the peer sees only the
   * link's credential, so a caller that may not control threads here is refused here. Work a
   * link started never uses this environment's links, since the peer would see this
   * environment's session instead of that link, and its fence could not hold.
   */
  const callerLimits = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.map((caller) => caller.limits),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
  ) {
    const limits = yield* callerLimits(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    return yield* peers.call({
      environmentId,
      tool: toolName,
      arguments: args,
      limits,
      success: success as Schema.Decoder<A>,
    });
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = Effect.fn(
    "PeerForwarding.waitForThread",
  )(function* (scope, environmentId, input) {
    let remaining = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    let runId = input.runId;
    while (true) {
      const chunk = Math.min(remaining, FORWARDED_WAIT_CHUNK_MS);
      const result = yield* forward<OrchestratorMcpThreadWaitResult>(
        scope,
        "t3_thread_wait",
        OrchestratorMcpThreadWaitInput,
        OrchestratorMcpThreadWaitResult,
        environmentId,
        {
          threadId: input.threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: chunk,
          ...(input.untilDelegatedWorkSettled === undefined
            ? {}
            : { untilDelegatedWorkSettled: input.untilDelegatedWorkSettled }),
        },
      );
      remaining -= chunk;
      if (!result.timedOut || remaining <= 0) return result;
      // Later pieces wait for the run the first one picked, not a newer one.
      runId = result.runId ?? undefined;
    }
  });

  // While the beta is off, agents start work only over agent links. Tasks already running
  // elsewhere keep following through readThread, waitForThread and interruptThread, so they
  // still finish.
  const requireUsable = (environmentId: EnvironmentId) =>
    links.enabled.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? Effect.void
          : links.agentLinks.pipe(
              Effect.flatMap((agentLinks) =>
                agentLinks.has(environmentId)
                  ? Effect.void
                  : Effect.fail(agentLinks.size === 0 ? linkedEnvironmentsOff : onlyAgentLinks),
              ),
            ),
      ),
    );

  const resolveProject: PeerForwarding["Service"]["resolveProject"] = Effect.fn(
    "PeerForwarding.resolveProject",
  )(function* (scope, environmentId, { parentProjectId, requested, argument }) {
    if (requested !== undefined) return requested;
    const here = yield* projects.getById(parentProjectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    // The project's own identity is a one-minute cache that reads blank when
    // cold, so resolve it here, as the other side's t3_project_list does. A
    // workspace's folder is not a repository; git would find an enclosing one.
    const key =
      here === undefined || here.roots !== undefined
        ? undefined
        : (yield* repositoryIdentities.resolve(here.workspaceRoot))?.canonicalKey;
    if (key === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: `Pass ${argument}: this thread's project has no repository to match there.`,
      });
    }
    const list = ProjectToolkit.tools.t3_project_list;
    const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof list> = yield* forward<Tool.Success<typeof list>>(
        scope,
        list.name,
        list.parametersSchema,
        list.successSchema,
        environmentId,
        { cursor, limit: 100 },
      );
      matches.push(
        ...listed.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
      );
      cursor = listed.nextCursor;
    }
    if (matches.length === 1) return matches[0]!.id;
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        matches.length === 0
          ? `No project there has this repository (${key}). Pass ${argument}; t3_project_list with this environmentId lists them. To bring the repository there, use t3_project_clone and then t3_project_create with this environmentId.`
          : `Several projects there have this repository: ${matches.map((project) => `${project.title} (${project.id})`).join(", ")}. Pass ${argument}.`,
    });
  });

  /**
   * A launch that names no project and is not scratch inherits the calling thread's, which
   * means nothing on a machine that has none of this one's projects: its project there is the
   * one with the same repository. A caller outside a thread keeps the other side's error.
   */
  const launch = Effect.fn("PeerForwarding.launch")(function* (
    scope: Scope,
    tool: Tool.Any,
    environmentId: EnvironmentId,
    params: Record<string, unknown>,
  ) {
    const shell =
      params.projectId !== undefined || params.scratch === true || scope.thread === undefined
        ? null
        : yield* threads.getThreadShell(scope.thread.threadId).pipe(Effect.mapError(unavailable));
    const projectId =
      shell === null
        ? params.projectId
        : yield* resolveProject(scope, environmentId, {
            parentProjectId: shell.projectId,
            requested: undefined,
            argument: "projectId",
          });
    return yield* forward(
      scope,
      tool.name,
      tool.parametersSchema,
      tool.successSchema,
      environmentId,
      projectId === undefined ? params : { ...params, projectId },
    );
  });

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) => {
    const forwarded: Effect.Effect<
      Tool.Success<typeof tool>,
      OrchestratorMcpFailure
    > = tool.name === "t3_thread_wait"
      ? (waitForThread(
          scope,
          environmentId,
          params as OrchestratorMcpThreadWaitInput,
        ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
      : tool.name === "t3_thread_launch"
        ? (launch(scope, tool, environmentId, params as Record<string, unknown>) as Effect.Effect<
            Tool.Success<typeof tool>,
            OrchestratorMcpFailure
          >)
        : forward(
            scope,
            tool.name,
            tool.parametersSchema,
            tool.successSchema,
            environmentId,
            params,
          );
    return Effect.andThen(requireUsable(environmentId), forwarded);
  };

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* callerLimits(scope);
      const enabled = yield* links.enabled;
      if (!enabled && (yield* links.agentLinks).size === 0) {
        return yield* linkedEnvironmentsOff;
      }
      const listed = yield* links.list.pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      // Read after listing, which corrects each link's marker from what its peer reported.
      const agentLinks = yield* links.agentLinks;
      return {
        environmentId: scope.environmentId,
        links: listed
          .filter((link) => enabled || agentLinks.has(link.environmentId))
          .map((link) => ({
            environmentId: link.environmentId,
            label: link.label,
            status: link.status,
            access: link.access,
            expiresAt: DateTime.formatIso(link.expiresAt),
            lastError: link.lastError,
            ...(agentLinks.has(link.environmentId) ? { cloud: true as const } : {}),
          })),
        notListed: NOT_LISTED,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readThread,
    interruptThread,
    waitForThread,
    resolveProject,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
