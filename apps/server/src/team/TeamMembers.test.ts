import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ADMIN_SCOPES, MEMBER_SCOPES, MemberId, type TeamStreamEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Members from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TeamMembers from "./TeamMembers.ts";
import * as TeamState from "./TeamState.ts";

const layerGitName = (name: string) =>
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: () =>
      Effect.succeed({
        stdout: `${name}\n`,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-members-test-" })),
);

const layerTeam = TeamMembers.layer.pipe(
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerGitName("Ada Lovelace")),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const requestMetadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

const signIn = (credential: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const exchange = yield* auth.createBrowserSession(credential, requestMetadata);
    const token = exchange.sessionToken;
    const authenticate = auth.authenticateHttpRequest({
      cookies: { [sessions.cookieName]: token },
      headers: {},
    } as unknown as Parameters<
      EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
    >[0]);
    return { session: yield* authenticate, authenticate };
  });

const sessionScopes = (sessionId: string) =>
  EnvironmentAuth.EnvironmentAuth.pipe(
    Effect.flatMap((auth) => auth.listSessions()),
    Effect.map((sessions) => sessions.find((session) => session.sessionId === sessionId)?.scopes),
  );

it.layer(layerTeam)("TeamMembers", (it) => {
  it.effect("invite creates a member whose one-time link signs in as that member", () =>
    Effect.gen(function* () {
      const team = yield* TeamMembers.TeamMembers;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const invited = yield* team.invite({
        name: "Alice",
        role: "member",
        gitEmail: "alice@example.com",
      });

      expect(invited.member).toMatchObject({
        name: "Alice",
        role: "member",
        isOwner: false,
        gitEmail: "alice@example.com",
      });
      expect(invited.member.color).toMatch(/^hsl\(/);
      const link = (yield* auth.listPairingLinks()).find(
        (candidate) => candidate.id === invited.credential.id,
      );
      expect(link).toMatchObject({ memberId: invited.member.id, label: "Invite: Alice" });
      expect(link?.permissions).toEqual(MEMBER_SCOPES);
      expect(Duration.toHours(DateTime.distance(link!.createdAt, link!.expiresAt))).toBe(24);

      const { session } = yield* signIn(invited.credential.credential);
      expect(session.memberId).toBe(invited.member.id);
      expect(session.scopes).toEqual(MEMBER_SCOPES);
    }),
  );

  it.effect.each(["updateSelf", "update"] as const)(
    "%s sets git fields that author commits and clears them with null",
    (method) =>
      Effect.gen(function* () {
        const team = yield* TeamMembers.TeamMembers;
        const { gitAuthorFor } = yield* TeamState.TeamState;
        const { member } = yield* team.invite({
          name: "Erin",
          role: "member",
          gitEmail: "erin@example.com",
        });
        const update = (input: { gitName?: string | null; gitEmail?: string | null }) =>
          method === "update"
            ? team.update({ memberId: member.id, ...input })
            : team.updateSelf(member.id, input);
        expect(yield* gitAuthorFor(member.id)).toEqual({ name: "Erin", email: "erin@example.com" });

        expect(yield* update({ gitName: "Erin Git" })).toMatchObject({
          gitName: "Erin Git",
          gitEmail: "erin@example.com",
        });
        expect(yield* gitAuthorFor(member.id)).toEqual({
          name: "Erin Git",
          email: "erin@example.com",
        });

        const cleared = yield* update({ gitName: null, gitEmail: null });
        expect(cleared).toMatchObject({ name: "Erin" });
        expect(cleared).not.toHaveProperty("gitName");
        expect(cleared).not.toHaveProperty("gitEmail");
        expect(yield* gitAuthorFor(member.id)).toBeUndefined();
      }),
  );

  it.effect("setRole widens only full-bundle sessions and narrows them back", () =>
    Effect.gen(function* () {
      const team = yield* TeamMembers.TeamMembers;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const invited = yield* team.invite({ name: "Bea", role: "member" });
      const { session } = yield* signIn(invited.credential.credential);
      const narrowed = yield* auth.issueSession({
        memberId: invited.member.id,
        scopes: ["orchestration:read"],
      });

      expect((yield* team.setRole({ memberId: invited.member.id, role: "admin" })).role).toBe(
        "admin",
      );
      expect(new Set(yield* sessionScopes(session.sessionId))).toEqual(new Set(ADMIN_SCOPES));
      expect(yield* sessionScopes(narrowed.sessionId)).toEqual(["orchestration:read"]);

      const adminLink = yield* team.signInLink({ memberId: invited.member.id });
      yield* team.setRole({ memberId: invited.member.id, role: "member" });
      expect(new Set(yield* sessionScopes(session.sessionId))).toEqual(new Set(MEMBER_SCOPES));
      expect(yield* sessionScopes(narrowed.sessionId)).toEqual(["orchestration:read"]);
      expect(
        (yield* auth.listPairingLinks()).some((link) => link.id === adminLink.credential.id),
      ).toBe(false);
    }),
  );

  it.effect("remove revokes sessions, unconsumed links and push devices", () =>
    Effect.gen(function* () {
      const team = yield* TeamMembers.TeamMembers;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sql = yield* SqlClient.SqlClient;
      const invited = yield* team.invite({ name: "Cleo", role: "member" });
      const { session, authenticate } = yield* signIn(invited.credential.credential);
      yield* team.signInLink({ memberId: invited.member.id });
      yield* sql`
        INSERT INTO member_push_devices (device_id, member_id, session_id, token, platform, updated_at)
        VALUES ('phone', ${invited.member.id}, ${session.sessionId}, 'ExponentPushToken[cleo]', 'ios', '2026-11-01T00:00:00.000Z')
      `;

      const removed = yield* team.remove({ memberId: invited.member.id });

      expect(yield* sql`SELECT device_id FROM member_push_devices`).toEqual([]);

      expect(removed.removedAt).not.toBeNull();
      expect((yield* Effect.flip(authenticate))._tag).toBe("ServerAuthInvalidCredentialError");
      expect(
        (yield* auth.listPairingLinks()).filter((link) => link.memberId === invited.member.id),
      ).toEqual([]);
      expect((yield* Effect.flip(team.signInLink({ memberId: invited.member.id }))).reason).toBe(
        "removed",
      );
    }),
  );

  it.effect("owner cannot be removed or demoted", () =>
    Effect.gen(function* () {
      const team = yield* TeamMembers.TeamMembers;
      const { ownerId } = yield* TeamState.TeamState;
      expect((yield* Effect.flip(team.remove({ memberId: ownerId }))).reason).toBe(
        "owner-immutable",
      );
      expect((yield* Effect.flip(team.setRole({ memberId: ownerId, role: "member" }))).reason).toBe(
        "owner-immutable",
      );
    }),
  );

  it.effect("stream emits snapshot, including members the CLI wrote, then upserts", () =>
    Effect.gen(function* () {
      const team = yield* TeamMembers.TeamMembers;
      const cliMemberId = MemberId.make("member-from-cli");
      yield* (yield* Members.MemberRepository).insert({
        id: cliMemberId,
        name: "Cli",
        role: "member",
        gitName: null,
        gitEmail: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const events = yield* Queue.unbounded<TeamStreamEvent>();
      yield* team.streamChanges.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const snapshot = yield* Queue.take(events);
      expect(
        snapshot._tag === "snapshot" && snapshot.members.some(({ id }) => id === cliMemberId),
      ).toBe(true);

      const invited = yield* team.invite({ name: "Dana", role: "member" });
      const removed = yield* team.remove({ memberId: invited.member.id });
      expect(yield* Queue.take(events)).toEqual({ _tag: "upserted", member: invited.member });
      expect(yield* Queue.take(events)).toEqual({ _tag: "upserted", member: removed });
    }),
  );
});

it.effect("renames the owner from git user.name once", () =>
  Effect.gen(function* () {
    const team = yield* TeamMembers.TeamMembers;
    const members = yield* Members.MemberRepository;
    const { ownerId } = yield* TeamState.TeamState;
    expect((yield* team.list).find((member) => member.id === ownerId)?.name).toBe("Ada Lovelace");

    yield* team.updateSelf(ownerId, { name: "Admin" });
    yield* TeamMembers.TeamMembers.pipe(
      Effect.provide(TeamMembers.layer.pipe(Layer.provide(layerGitName("Grace Hopper")))),
    );
    expect((yield* members.getOwner()).name).toBe("Admin");
  }).pipe(Effect.provide(layerTeam)),
);
