import { describe, expect, it } from "@effect/vitest";
import {
  MemberId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type PairBuilderSessionsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as Members from "../persistence/Members.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TeamState from "../team/TeamState.ts";
import { layerHostConfig, threadShell, WORKSPACE_PROJECT_ID } from "./PairBuilder.testkit.ts";
import * as SessionsSnapshotPublisher from "./SessionsSnapshotPublisher.ts";

const member = (id: string, name: string, extra: Partial<Members.MemberRecord> = {}) =>
  ({
    id: MemberId.make(id),
    name,
    role: "member",
    gitName: null,
    gitEmail: null,
    isOwner: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: null,
    removedAt: null,
    ...extra,
  }) satisfies Members.MemberRecord;
const OWNER = member("owner", "Owner", { isOwner: true, role: "admin" });
const ADA = member("ada", "Ada", { pairBuilderUserId: "u-1" });

const userMessage = (
  text: string,
  at: string,
  extra: Partial<OrchestrationV2ConversationMessage>,
) =>
  ({
    text,
    role: "user",
    createdBy: "user",
    createdAt: DateTime.makeUnsafe(at),
    ...extra,
  }) as OrchestrationV2ConversationMessage;

/** `statuses` answers the Builder's requests in order, then 204; `null` never answers. */
const startPublisher = Effect.fn(function* (statuses: ReadonlyArray<number | null> = []) {
  const posts = yield* Queue.unbounded<{
    readonly body: PairBuilderSessionsSnapshot;
    readonly authorization: string | undefined;
    readonly url: string;
  }>();
  const answers = yield* Ref.make(statuses);
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      yield* Queue.offer(posts, {
        body: JSON.parse(new TextDecoder().decode(body)),
        authorization: request.headers.authorization,
        url: request.url,
      });
      const status = yield* Ref.modify(answers, ([next = 204, ...rest]) => [next, rest]);
      if (status === null) return yield* Effect.never;
      return HttpClientResponse.fromWeb(request, new Response(null, { status }));
    }),
  );
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const active = [
    threadShell("t-ada", { title: "New thread", ownerId: ADA.id }),
    threadShell("t-sub", {
      lineage: {
        rootThreadId: ThreadId.make("t-ada"),
        parentThreadId: ThreadId.make("t-ada"),
        relationshipToParent: "subagent",
      },
    }),
  ];
  const archived = [
    threadShell("t-owner", {
      ownerId: OWNER.id,
      archivedAt: DateTime.makeUnsafe("2026-11-01T00:10:00.000Z"),
    }),
  ];
  const dependencies = Layer.mergeAll(
    layerHostConfig({
      ingressToken: Redacted.make("ingress"),
      sandboxId: "sandbox-1",
      workspaceRoot: "/projects/challenge",
      workspaceTitle: undefined,
      events: { url: new URL("http://builder/events"), token: Redacted.make("events-token") },
    }),
    TeamState.layerTest([OWNER, ADA]),
    Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (workspaceRoot) =>
        Effect.succeed(
          workspaceRoot === "/projects/challenge"
            ? Option.some({ id: WORKSPACE_PROJECT_ID } as never)
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      streamDomainEvents: Stream.fromQueue(events),
      getShellSnapshot: (options) =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: options?.projectId === WORKSPACE_PROJECT_ID ? active : [],
          archivedThreads: options?.projectId === WORKSPACE_PROJECT_ID ? archived : [],
        }),
      getThreadRecords: (threadId) =>
        Effect.succeed({
          messages:
            threadId === "t-ada"
              ? [
                  userMessage("Second", "2026-11-01T00:02:00.000Z", {}),
                  userMessage("Woken", "2026-11-01T00:00:30.000Z", { createdBy: "system" }),
                  userMessage("Please fix the login bug", "2026-11-01T00:01:00.000Z", {}),
                ]
              : [],
        } as never),
    }),
    Layer.mock(SessionStore.SessionStore)({
      cookieName: "t3_session",
      legacyCookieName: undefined,
      connectionCount: Effect.succeed(2),
      streamChanges: Stream.never,
    }),
    Layer.succeed(HttpClient.HttpClient, http),
  );
  const publisher = yield* SessionsSnapshotPublisher.SessionsSnapshotPublisher.pipe(
    Effect.provide(SessionsSnapshotPublisher.layer.pipe(Layer.provide(dependencies))),
  );
  yield* publisher.start;
  return {
    posts,
    change: Queue.offer(events, {} as OrchestrationV2DomainEvent),
    /** How many snapshots arrive while the clock moves on by `millis`. */
    sentWithin: (millis: number) =>
      TestClock.adjust(millis).pipe(
        Effect.andThen(Queue.clear(posts)),
        Effect.map((sent) => sent.length),
      ),
  };
});

describe("SessionsSnapshotPublisher", () => {
  it.effect("posts the workspace's top-level threads to the Builder", () =>
    Effect.gen(function* () {
      const { posts } = yield* startPublisher();
      yield* TestClock.adjust(250);
      const post = yield* Queue.take(posts);
      expect(post.url).toBe("http://builder/events");
      expect(post.authorization).toBe("Bearer events-token");
      expect(post.body).toMatchObject({
        type: "sessions.snapshot",
        sandbox_id: "sandbox-1",
        connections: 2,
      });
      expect(post.body.sessions).toMatchObject([
        {
          id: "t-ada",
          first_message: "Please fix the login bug",
          title: "Please fix the login bug",
          archived: false,
          created_by: { id: "u-1", name: "Ada" },
        },
        { id: "t-owner", archived: true, created_by: null },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("debounces changes, sends at most once a second, and beats every 30 seconds", () =>
    Effect.gen(function* () {
      const { change, sentWithin } = yield* startPublisher();
      expect(yield* sentWithin(249)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);

      // A change right after a send waits out the one-second interval.
      yield* change;
      expect(yield* sentWithin(999)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);

      // A burst once the interval has passed is one snapshot, 250 ms after it starts.
      yield* sentWithin(2_000);
      yield* change;
      yield* change;
      yield* change;
      expect(yield* sentWithin(249)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);

      expect(yield* sentWithin(29_999)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);
      expect(yield* sentWithin(30_000)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off from 1 second, gives up on a request after 5, and recovers", () =>
    Effect.gen(function* () {
      const { change, sentWithin } = yield* startPublisher([500, null, 503]);
      expect(yield* sentWithin(250)).toBe(1);
      // Changes during the backoff wait for the retry instead of sending early.
      yield* change;
      expect(yield* sentWithin(999)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);
      // That attempt never answers: it times out after 5 s, then waits 2 s.
      expect(yield* sentWithin(6_999)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);
      expect(yield* sentWithin(3_999)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);
      // Delivered: back to waiting for changes.
      yield* change;
      expect(yield* sentWithin(999)).toBe(0);
      expect(yield* sentWithin(1)).toBe(1);
    }).pipe(Effect.scoped),
  );
});
