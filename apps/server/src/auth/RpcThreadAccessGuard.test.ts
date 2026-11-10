import { expect, it } from "@effect/vitest";
import {
  MemberId,
  ORCHESTRATION_V2_WS_METHODS,
  RPC_THREAD_TARGETS,
  RpcThreadAccess,
  SandboxId,
  type SandboxAccessChange,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as RpcThreadAccessGuard from "./RpcThreadAccessGuard.ts";

const bob = MemberId.make("member-bob");
const carol = MemberId.make("member-carol");
const PRIVATE_SANDBOX = SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa");
const SHARED_SANDBOX = SandboxId.make("sbx_bbbbbbbbbbbbbbbbbbbb");

/** Bob's machine is his alone and the team machine is everyone's, until a test changes that. */
const setup = Effect.fnUntraced(function* (options: { readonly enforced?: boolean } = {}) {
  const machines = new Map<SandboxId, ThreadAccess.SandboxAccessEntry>([
    [PRIVATE_SANDBOX, { ownerMemberId: bob, audience: "members", memberIds: new Set() }],
    [SHARED_SANDBOX, { ownerMemberId: bob, audience: "team", memberIds: new Set() }],
  ]);
  const threads = new Map<ThreadId, ThreadAccess.ThreadAccessTarget>([
    [ThreadId.make("thread-private"), { ownerId: bob, sandboxId: PRIVATE_SANDBOX }],
    [ThreadId.make("thread-shared"), { ownerId: bob, sandboxId: SHARED_SANDBOX }],
    [ThreadId.make("thread-unassigned"), { ownerId: null }],
  ]);
  const changes = yield* PubSub.unbounded<SandboxAccessChange>();
  const moves = yield* PubSub.unbounded<ThreadAccess.ThreadAccessMove>();
  /** Commits a thread's new owner or machine, as the index does. */
  const move = (threadId: string, after: ThreadAccess.ThreadAccessTarget) => {
    const id = ThreadId.make(threadId);
    const before = threads.get(id) ?? {};
    threads.set(id, after);
    return PubSub.publish(moves, { sequence: 1, threadId: id, before, after });
  };
  const layer = RpcThreadAccessGuard.layer(carol).pipe(
    Layer.provide(
      ThreadAccess.layerTest(
        options.enforced === false
          ? undefined
          : { serverOwnerId: bob, machines, threads, changes, moves },
      ),
    ),
  );
  /** Runs `method` through the guard; the handler stub reports whether it ran. */
  const call = (method: string, payload: unknown, handler: Effect.Effect<unknown> = Effect.void) =>
    Effect.gen(function* () {
      const guard = yield* RpcThreadAccess;
      const rpc = WsRpcGroup.requests.get(method);
      if (rpc === undefined) return yield* Effect.die(`No RPC ${method}`);
      let ran = false;
      const result = yield* guard(
        handler.pipe(Effect.ensuring(Effect.sync(() => (ran = true)))) as never,
        { rpc, payload, client: {}, requestId: 0, headers: {} } as never,
      ).pipe(
        Effect.as("allowed" as const),
        Effect.catchTags({
          EnvironmentResourceNotFoundError: (error) =>
            Effect.succeed(error.reason === "thread_not_found" ? ("missing" as const) : "other"),
        }),
        Effect.scoped,
      );
      return { result, ran };
    }).pipe(Effect.provide(layer));
  return { call, machines, changes, move };
});

/** Every field the table reads, all pointing at one thread and one machine. */
const universalPayload = (threadId: string, root: string) => ({
  threadId,
  conversationThreadId: threadId,
  cwd: root,
  worktreePath: root,
  path: root,
  paths: [root],
  destinationPath: root,
  relativePath: "src/index.ts",
  directoryPath: "src",
  partialPath: root,
  expectedWorkspaceRoot: root,
  scriptPath: `${root}/workflow.ts`,
  workspaceRoot: root,
  reuseExistingThread: true,
  workspaceStrategy: { type: "existing_worktree", worktreePath: root },
  resource: { _tag: "workspace-file", threadId, path: `${root}/a.png` },
});

it.effect("refuses every table method a thread or machine the member cannot open", () =>
  Effect.gen(function* () {
    const { call } = yield* setup();
    for (const method of Object.keys(RPC_THREAD_TARGETS)) {
      const refused = yield* call(
        method,
        universalPayload("thread-private", `/t3-sandbox/${PRIVATE_SANDBOX}/repo`),
      );
      expect({ method, ...refused }).toEqual({ method, result: "missing", ran: false });
      const allowed = yield* call(
        method,
        universalPayload("thread-shared", `/t3-sandbox/${SHARED_SANDBOX}/repo`),
      );
      expect({ method, ...allowed }).toEqual({ method, result: "allowed", ran: true });
    }
  }),
);

it.effect("refuses unknown threads and machines, and paths that climb into another machine", () =>
  Effect.gen(function* () {
    const { call } = yield* setup();
    const read = (cwd: string, relativePath = "README.md") =>
      call(WS_METHODS.projectsReadFile, { cwd, relativePath }).pipe(
        Effect.map(({ result }) => result),
      );
    expect(
      (yield* call(WS_METHODS.terminalWrite, { threadId: "thread-unknown", data: "ls" })).result,
    ).toBe("missing");
    expect(yield* read(`/t3-sandbox/${SHARED_SANDBOX}/../${PRIVATE_SANDBOX}/repo`)).toBe("missing");
    expect(yield* read(`/t3-sandbox/${SHARED_SANDBOX}/repo`, `../../${PRIVATE_SANDBOX}/x`)).toBe(
      "missing",
    );
    expect(yield* read(`/t3-sandbox/${SHARED_SANDBOX}//./../sbx_cccccccccccccccccccc/x`)).toBe(
      "missing",
    );
    expect(yield* read("/t3-sandbox/not-a-machine")).toBe("missing");
    expect(yield* read(`/t3-sandbox/${SHARED_SANDBOX}/repo`)).toBe("allowed");
    // Local paths are 2.45's to confine, so a cloud-only server's own disk passes here.
    expect(yield* read("/home/carol/repo")).toBe("allowed");
    expect(yield* read("relative/repo")).toBe("allowed");
    // A launch's new id that names Bob's private thread is refused as missing, not "already exists".
    const launch = (threadId: string) =>
      call(ORCHESTRATION_V2_WS_METHODS.launchThread, {
        threadId,
        workspaceStrategy: { type: "local" },
      }).pipe(Effect.map(({ result }) => result));
    expect(yield* launch("thread-private")).toBe("missing");
    expect(yield* launch("thread-new")).toBe("allowed");
    expect(yield* launch("thread-shared")).toBe("allowed");
    // The guard sees only the member, so an admin's `access:write` methods refuse alike.
    for (const method of [WS_METHODS.guestShareCreate, WS_METHODS.peerLinksAnswerRequest]) {
      const unknown = yield* call(method, { threadId: "thread-unknown" });
      expect(yield* call(method, { threadId: "thread-private" })).toEqual(unknown);
      expect(unknown).toEqual({ result: "missing", ran: false });
    }
  }),
);

it.effect("checks nothing where access is not enforced", () =>
  Effect.gen(function* () {
    const { call } = yield* setup({ enforced: false });
    const { result, ran } = yield* call(
      WS_METHODS.terminalOpen,
      universalPayload("thread-private", `/t3-sandbox/${PRIVATE_SANDBOX}/repo`),
    );
    expect({ result, ran }).toEqual({ result: "allowed", ran: true });
  }),
);

it.effect.each([
  {
    method: WS_METHODS.terminalAttach,
    payload: { threadId: "thread-shared", terminalId: "default" },
  },
  { method: WS_METHODS.subscribeDiscoveredLocalServers, payload: { threadId: "thread-shared" } },
])("ends $method when the member loses its machine", ({ method, payload }) =>
  Effect.gen(function* () {
    const { call, machines, changes } = yield* setup();
    const started = yield* Deferred.make<void>();
    const attach = yield* call(
      method,
      payload,
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const change = (sandboxId: SandboxId): SandboxAccessChange => ({
      sandboxId,
      access: {
        audience: "members",
        memberIds: [],
        updatedBy: bob,
        updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      },
      added: [],
      removed: [],
      audienceChanged: true,
      actorId: bob,
    });
    // Another machine's change, then this one's: only the second ends the stream.
    yield* PubSub.publish(changes, change(PRIVATE_SANDBOX));
    machines.set(SHARED_SANDBOX, { ownerMemberId: bob, audience: "members", memberIds: new Set() });
    yield* PubSub.publish(changes, change(SHARED_SANDBOX));
    expect(yield* Fiber.join(attach)).toEqual({ result: "missing", ran: true });
  }),
);

it.effect(
  "ends a stream when its thread gets an owner or moves to a machine the member lacks",
  () =>
    Effect.gen(function* () {
      const { call, move } = yield* setup();
      const attach = Effect.fnUntraced(function* (threadId: string) {
        const started = yield* Deferred.make<void>();
        const fiber = yield* call(
          WS_METHODS.terminalAttach,
          { threadId, terminalId: "default" },
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        return fiber;
      });

      // Every member opens a thread with no owner and no machine, until someone is given it.
      const unassigned = yield* attach("thread-unassigned");
      yield* move("thread-shared", { ownerId: carol, sandboxId: SHARED_SANDBOX });
      yield* move("thread-unassigned", { ownerId: bob });
      expect(yield* Fiber.join(unassigned)).toEqual({ result: "missing", ran: true });

      const shared = yield* attach("thread-shared");
      yield* move("thread-shared", { ownerId: carol, sandboxId: PRIVATE_SANDBOX });
      expect(yield* Fiber.join(shared)).toEqual({ result: "missing", ran: true });
    }),
);
