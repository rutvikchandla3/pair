import { SandboxId } from "@t3tools/contracts";
import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerInfo,
  type RunnerLimits,
  RunnerLostError,
  RunnerRpcGroup,
} from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Headers from "effect/http/Headers";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import type { CoarseOperations } from "../../workspaceHost/WorkspaceHost.ts";
import * as RunnerOpsClient from "./RunnerOpsClient.ts";
import {
  RunnerAuthError,
  type RunnerGrant,
  type RunnerGrantError,
  RunnerGrants,
} from "./RunnerGrants.ts";

/** Processes survive a socket drop this long (03 §3.1); one value until a driver needs another. */
const LEASE = Duration.seconds(120);
const LIMITS: RunnerLimits = {
  windowBytes: 256 * 1024,
  windowChunks: 16,
  handleBufferBytes: 4 * 1024 * 1024,
  ptyBufferBytes: 1024 * 1024,
  sandboxBufferBytes: 64 * 1024 * 1024,
};
/** The runner's own cap (runner/main.ts): a 256 KiB chunk plus its envelope. */
const MAX_FRAME_BYTES = 256 * 1024 + 1024;
const PROTOCOL_HEADER = "x-pair-runner-protocol";
const CREDENTIAL = /^(Enroll|Bearer) ([A-Za-z0-9_-]+)$/;

const parseCredential = (headers: Headers.Headers) => {
  const authorization = Headers.get(headers, "authorization");
  if (Option.isNone(authorization)) return Effect.fail(new RunnerAuthError({ reason: "missing" }));
  const match = CREDENTIAL.exec(authorization.value);
  if (match === null) return Effect.fail(new RunnerAuthError({ reason: "malformed" }));
  return Effect.succeed({ scheme: match[1], credential: Redacted.make(match[2]!) });
};

export class RunnerProtocolMismatchError extends Schema.TaggedError<RunnerProtocolMismatchError>()(
  "RunnerProtocolMismatchError",
  { expected: Schema.Number, received: Schema.String },
) {}

export class RunnerUnavailableError extends Schema.TaggedError<RunnerUnavailableError>()(
  "RunnerUnavailableError",
  { sandboxId: SandboxId },
) {}

export type RunnerClient = RpcClient.FromGroup<typeof RunnerRpcGroup, RpcClientError>;

/** One socket's typed client. 1.8 adds resumable wrappers; callers must not keep it across drops. */
export interface RunnerConnection {
  readonly client: RunnerClient;
  readonly info: RunnerInfo;
  readonly ops: CoarseOperations;
}

export type RunnerConnectionStatus =
  | { readonly _tag: "absent" }
  | {
      readonly _tag: "connected";
      readonly generation: number;
      readonly runnerBootId: string;
      readonly info: RunnerInfo;
    }
  | { readonly _tag: "reconnecting"; readonly since: DateTime.Utc; readonly runnerBootId: string }
  | { readonly _tag: "lost"; readonly runnerBootId: string };

export type RunnerHubFact =
  | {
      readonly _tag: "attached";
      readonly sandboxId: SandboxId;
      readonly generation: number;
      readonly runnerBootId: string;
      readonly info: RunnerInfo;
    }
  | {
      readonly _tag: "lost";
      readonly sandboxId: SandboxId;
      readonly generation: number;
      readonly runnerBootId: string;
      readonly reason: "lease-expired" | "runner-restarted";
    };

/** An authenticated connect. The token is present only on the enrollment connect. */
export interface AuthenticatedRunner extends RunnerGrant {
  readonly sandboxToken: Option.Option<Redacted.Redacted<string>>;
}

export class RunnerHub extends Context.Service<
  RunnerHub,
  {
    readonly mintEnrollment: (
      sandboxId: SandboxId,
      bootGeneration: number,
    ) => Effect.Effect<Redacted.Redacted<string>, RunnerGrantError>;
    /** Waits up to the lease for a connected runner (also for a first hello). */
    readonly connection: (
      sandboxId: SandboxId,
    ) => Effect.Effect<RunnerConnection, RunnerUnavailableError | RunnerLostError>;
    readonly status: (sandboxId: SandboxId) => Stream.Stream<RunnerConnectionStatus>;
    readonly revoke: (sandboxId: SandboxId) => Effect.Effect<void, RunnerGrantError>;
    /** Route only: checks the protocol before the credential, so a 426 never burns a secret. */
    readonly authenticate: (
      headers: Headers.Headers,
    ) => Effect.Effect<
      AuthenticatedRunner,
      RunnerAuthError | RunnerProtocolMismatchError | RunnerGrantError
    >;
    /** Route only: bundle downloads take a sandbox token or an unspent enrollment secret. */
    readonly authorizeDownload: (
      headers: Headers.Headers,
    ) => Effect.Effect<RunnerGrant, RunnerAuthError | RunnerGrantError>;
    /** Route only: serves the upgraded socket until it ends, is replaced or is revoked. */
    readonly serve: (runner: AuthenticatedRunner, socket: Socket.Socket) => Effect.Effect<void>;
    /** One consumer: `RunnerHubFacts`. */
    readonly facts: Stream.Stream<RunnerHubFact>;
  }
>()("t3/sandbox/runnerHub/RunnerHub") {}

interface SlotState {
  readonly status: RunnerConnectionStatus;
  readonly connection: RunnerConnection | undefined;
  readonly lostReason: RunnerLostError["reason"];
}

interface Slot {
  readonly sandboxId: SandboxId;
  readonly state: SubscriptionRef.SubscriptionRef<SlotState>;
  /** The newest boot generation minted or served this server boot. */
  generation: number;
  boot: { readonly generation: number; readonly runnerBootId: string } | undefined;
  live: { readonly id: number; readonly close: Deferred.Deferred<void> } | undefined;
  /** Bumped whenever a pending lease must not fire. */
  leaseEpoch: number;
}

const absent: SlotState = {
  status: { _tag: "absent" },
  connection: undefined,
  lostReason: "lease-expired",
};

const make = Effect.gen(function* () {
  const grants = yield* RunnerGrants;
  const random = yield* SecureRandom.SecureRandom;
  const serialization = yield* RpcSerialization.RpcSerialization.pipe(
    Effect.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: MAX_FRAME_BYTES })),
  );
  const serverBootId = yield* random.uuidV4();
  const facts = yield* Queue.unbounded<RunnerHubFact>();
  const leases = yield* FiberMap.make<SandboxId>();
  // Every slot change runs under this lock; nothing slow runs inside it.
  const lock = yield* Semaphore.make(1);
  const locked = Semaphore.withPermit(lock);
  const slots = new Map<SandboxId, Slot>();
  let nextSocketId = 0;

  const slotFor = Effect.fnUntraced(function* (sandboxId: SandboxId) {
    const existing = slots.get(sandboxId);
    if (existing !== undefined) return existing;
    const slot: Slot = {
      sandboxId,
      state: yield* SubscriptionRef.make(absent),
      generation: 0,
      boot: undefined,
      live: undefined,
      leaseEpoch: 0,
    };
    slots.set(sandboxId, slot);
    return slot;
  });

  // Untraced: slot bookkeeping under the lock, inside the traced hub operations.
  const setState = Effect.fnUntraced(function* (slot: Slot, next: SlotState) {
    const current = yield* SubscriptionRef.get(slot.state);
    const same =
      current.status._tag === next.status._tag &&
      current.connection === next.connection &&
      ("runnerBootId" in current.status ? current.status.runnerBootId : undefined) ===
        ("runnerBootId" in next.status ? next.status.runnerBootId : undefined);
    if (!same) yield* SubscriptionRef.set(slot.state, next);
  });

  const cancelLease = (slot: Slot) =>
    Effect.suspend(() => {
      slot.leaseEpoch += 1;
      return FiberMap.remove(leases, slot.sandboxId);
    });

  const closeLive = (slot: Slot) =>
    Effect.suspend(() => {
      const live = slot.live;
      slot.live = undefined;
      return live === undefined ? Effect.void : Deferred.succeed(live.close, undefined);
    });

  const expire = Effect.fnUntraced(function* (slot: Slot, epoch: number) {
    const { status } = yield* SubscriptionRef.get(slot.state);
    if (slot.leaseEpoch !== epoch || status._tag !== "reconnecting" || slot.boot === undefined) {
      return;
    }
    yield* setState(slot, {
      status: { _tag: "lost", runnerBootId: status.runnerBootId },
      connection: undefined,
      lostReason: "lease-expired",
    });
    Queue.offerUnsafe(facts, {
      _tag: "lost",
      sandboxId: slot.sandboxId,
      generation: slot.boot.generation,
      runnerBootId: slot.boot.runnerBootId,
      reason: "lease-expired",
    });
  }, locked);

  /** A connected runner's socket is gone: wait out the lease for it to come back. */
  const startReconnecting = Effect.fnUntraced(function* (slot: Slot) {
    const { status } = yield* SubscriptionRef.get(slot.state);
    if (status._tag !== "connected") return;
    slot.leaseEpoch += 1;
    const epoch = slot.leaseEpoch;
    // Started before the status changes, so whoever sees `reconnecting` sees the lease running.
    yield* FiberMap.run(
      leases,
      slot.sandboxId,
      Effect.sleep(LEASE).pipe(Effect.andThen(expire(slot, epoch))),
      { startImmediately: true },
    );
    yield* setState(slot, {
      status: {
        _tag: "reconnecting",
        since: yield* DateTime.now,
        runnerBootId: status.runnerBootId,
      },
      connection: undefined,
      lostReason: "lease-expired",
    });
  });

  const attach = Effect.fnUntraced(function* (
    slot: Slot,
    socketId: number,
    runner: AuthenticatedRunner,
    connection: RunnerConnection,
  ) {
    if (slot.live?.id !== socketId) return false;
    const { status } = yield* SubscriptionRef.get(slot.state);
    const { runnerBootId } = connection.info;
    const previous = slot.boot;
    const alive = status._tag === "connected" || status._tag === "reconnecting";
    const sameBoot =
      previous !== undefined &&
      previous.generation === runner.generation &&
      previous.runnerBootId === runnerBootId;
    if (previous !== undefined && alive && !sameBoot) {
      Queue.offerUnsafe(facts, {
        _tag: "lost",
        sandboxId: slot.sandboxId,
        generation: previous.generation,
        runnerBootId: previous.runnerBootId,
        reason: "runner-restarted",
      });
    }
    if (!(alive && sameBoot)) {
      Queue.offerUnsafe(facts, {
        _tag: "attached",
        sandboxId: slot.sandboxId,
        generation: runner.generation,
        runnerBootId,
        info: connection.info,
      });
    }
    slot.boot = { generation: runner.generation, runnerBootId };
    yield* cancelLease(slot);
    yield* setState(slot, {
      status: {
        _tag: "connected",
        generation: runner.generation,
        runnerBootId,
        info: connection.info,
      },
      connection,
      lostReason: "lease-expired",
    });
    return true;
  });

  const mintEnrollment: RunnerHub["Service"]["mintEnrollment"] = Effect.fn(
    "RunnerHub.mintEnrollment",
  )(function* (sandboxId, bootGeneration) {
    const secret = yield* grants.mint(sandboxId, bootGeneration);
    // A new boot supersedes the old one: its socket closes and status starts over.
    yield* Effect.gen(function* () {
      const slot = yield* slotFor(sandboxId);
      if (bootGeneration <= slot.generation) return;
      slot.generation = bootGeneration;
      yield* closeLive(slot);
      yield* cancelLease(slot);
      yield* setState(slot, absent);
    }).pipe(locked);
    return secret;
  });

  const revoke: RunnerHub["Service"]["revoke"] = Effect.fn("RunnerHub.revoke")(
    function* (sandboxId) {
      yield* grants.revoke(sandboxId);
      yield* Effect.gen(function* () {
        const slot = yield* slotFor(sandboxId);
        yield* closeLive(slot);
        yield* cancelLease(slot);
        yield* setState(
          slot,
          slot.boot === undefined
            ? absent
            : {
                status: { _tag: "lost", runnerBootId: slot.boot.runnerBootId },
                connection: undefined,
                lostReason: "drained",
              },
        );
      }).pipe(locked);
    },
  );

  const connection: RunnerHub["Service"]["connection"] = Effect.fn("RunnerHub.connection")(
    function* (sandboxId) {
      const slot = yield* slotFor(sandboxId).pipe(locked);
      const settled = yield* SubscriptionRef.changes(slot.state).pipe(
        Stream.filter((state) => state.status._tag === "connected" || state.status._tag === "lost"),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption(() => new RunnerUnavailableError({ sandboxId }))),
        Effect.timeoutOrElse({
          duration: LEASE,
          orElse: () => Effect.fail(new RunnerUnavailableError({ sandboxId })),
        }),
      );
      if (settled.connection === undefined) {
        return yield* new RunnerLostError({ reason: settled.lostReason });
      }
      return settled.connection;
    },
  );

  const status: RunnerHub["Service"]["status"] = (sandboxId) =>
    Stream.unwrap(
      slotFor(sandboxId).pipe(
        locked,
        Effect.map((slot) =>
          SubscriptionRef.changes(slot.state).pipe(Stream.map((state) => state.status)),
        ),
      ),
    );

  const authenticate: RunnerHub["Service"]["authenticate"] = Effect.fn("RunnerHub.authenticate")(
    function* (headers) {
      const protocol = Option.getOrElse(Headers.get(headers, PROTOCOL_HEADER), () => "");
      if (protocol !== String(RUNNER_PROTOCOL_VERSION)) {
        return yield* new RunnerProtocolMismatchError({
          expected: RUNNER_PROTOCOL_VERSION,
          received: protocol,
        });
      }
      const { scheme, credential } = yield* parseCredential(headers);
      if (scheme === "Enroll") {
        const { grant, token } = yield* grants.enroll(credential);
        return { ...grant, sandboxToken: Option.some(token) };
      }
      const grant = yield* grants.authenticate(credential);
      return { ...grant, sandboxToken: Option.none() };
    },
  );

  const authorizeDownload: RunnerHub["Service"]["authorizeDownload"] = Effect.fn(
    "RunnerHub.authorizeDownload",
  )(function* (headers) {
    const { credential } = yield* parseCredential(headers);
    return yield* grants.authorizeDownload(credential);
  });

  const serve: RunnerHub["Service"]["serve"] = Effect.fn("RunnerHub.serve")(
    function* (runner, socket) {
      const socketId = nextSocketId++;
      const close = yield* Deferred.make<void>();
      const slot = yield* Effect.gen(function* () {
        const slot = yield* slotFor(runner.sandboxId);
        // A connect authenticated just before a newer boot was minted.
        if (runner.generation < slot.generation) return undefined;
        slot.generation = runner.generation;
        // Half-open sockets are common after a network change: the newest connect wins.
        yield* closeLive(slot);
        yield* startReconnecting(slot);
        slot.live = { id: socketId, close };
        return slot;
      }).pipe(locked);
      if (slot === undefined) {
        yield* Effect.logInfo("runner connect for a superseded boot refused", {
          generation: runner.generation,
        });
        return;
      }

      yield* Effect.gen(function* () {
        const disconnected = yield* Deferred.make<void>();
        const protocol = yield* RpcClient.makeProtocolSocket({
          pingInterval: "15 seconds",
          pingTimeout: "45 seconds",
          // The runner redials; a dead socket is never reused.
          retryPolicy: Schedule.recurs(0),
        }).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provideService(RpcClient.ConnectionHooks, {
            onConnect: Effect.void,
            onDisconnect: Deferred.succeed(disconnected, undefined),
          }),
          Effect.provideService(RpcSerialization.RpcSerialization, serialization),
        );
        const client = yield* RpcClient.make(RunnerRpcGroup).pipe(
          Effect.provideService(RpcClient.Protocol, protocol),
        );
        const info = yield* client["runner.hello"]({
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          serverBootId,
          leaseMs: Duration.toMillis(LEASE),
          limits: LIMITS,
          ...(Option.isSome(runner.sandboxToken)
            ? { sandboxToken: runner.sandboxToken.value }
            : {}),
        });
        const ops = yield* RunnerOpsClient.make(client);
        const current = yield* attach(slot, socketId, runner, { client, info, ops }).pipe(locked);
        if (current) yield* Deferred.await(disconnected);
      }).pipe(
        Effect.raceFirst(Deferred.await(close)),
        Effect.catchCause((cause) => Effect.logInfo("runner socket ended", { cause })),
        Effect.ensuring(
          Effect.gen(function* () {
            if (slot.live?.id !== socketId) return;
            slot.live = undefined;
            yield* startReconnecting(slot);
          }).pipe(locked),
        ),
        Effect.scoped,
      );
    },
    (effect, runner) =>
      Effect.annotateLogs(effect, { sandboxId: runner.sandboxId, generation: runner.generation }),
  );

  return RunnerHub.of({
    mintEnrollment,
    connection,
    status,
    revoke,
    authenticate,
    authorizeDownload,
    serve,
    facts: Stream.fromQueue(facts),
  });
});

export const layer = Layer.effect(RunnerHub, make);
