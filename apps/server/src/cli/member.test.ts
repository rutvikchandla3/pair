// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths and a local server.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ADMIN_SCOPES,
  MEMBER_SCOPES,
  MemberId,
  type TeamMember,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import { HttpRouter, HttpServer } from "effect/http";
import { type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as TestConsole from "effect/testing/TestConsole";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as RpcThreadAccessGuard from "../auth/RpcThreadAccessGuard.ts";
import { cli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* effect;
    return String((yield* TestConsole.logLines).at(-1));
  }).pipe(Effect.provide(TestConsole.layer));

const writeRuntimeState = Effect.fn("MemberCliTest.writeRuntimeState")(function* (
  baseDir: string,
  port: number,
) {
  yield* persistServerRuntimeState({
    path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
    state: yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port,
    }),
  });
});

const makeBaseDir = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-member-cli-" })),
);

type WsTag = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];
const servedTags = [WS_METHODS.teamSubscribe, WS_METHODS.teamInvite, WS_METHODS.teamRemove];
const TeamRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<WsTag, (typeof servedTags)[number]> =>
      !(servedTags as ReadonlyArray<string>).includes(tag),
  ),
);

const remoteAlice: TeamMember = {
  id: MemberId.make("remote-alice"),
  name: "Alice",
  role: "member",
  color: "hsl(0, 60%, 50%)",
  isOwner: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  removedAt: null,
};

/** Serves only the team RPCs, recording what the CLI asked the server to do. */
const serveTeam = Effect.fn("MemberCliTest.serveTeam")(function* (calls: Array<string>) {
  const handlers = TeamRpcs.toLayer({
    [WS_METHODS.teamSubscribe]: () =>
      Stream.make({ _tag: "snapshot" as const, members: [remoteAlice] }),
    [WS_METHODS.teamInvite]: ({ name, role }) =>
      Effect.sync(() => calls.push(`invite ${name} ${role}`)).pipe(
        Effect.as({
          member: { ...remoteAlice, id: MemberId.make("remote-carol"), name, role },
          credential: {
            id: "remote-link",
            credential: "REMOTECODE",
            expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
          },
        }),
      ),
    [WS_METHODS.teamRemove]: ({ memberId }) =>
      Effect.sync(() => calls.push(`remove ${memberId}`)).pipe(
        Effect.as({ ...remoteAlice, removedAt: "2026-11-05T00:00:00.000Z" }),
      ),
  });
  const context = yield* HttpRouter.serve(
    RpcServer.layerHttp({ group: TeamRpcs, path: "/ws", protocol: "websocket" }),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        handlers,
        RpcAuthorization.layer(ADMIN_SCOPES),
        RpcThreadAccessGuard.passThrough,
        RpcSerialization.layerJson,
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.build,
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
  return address.port;
});

const parse = <A>(output: string) => JSON.parse(output) as A;

describe("t3 member", () => {
  it.effect("writes directly when the recorded server does not answer", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      // A live pid with nothing listening, as after a crash whose pid was reused.
      yield* writeRuntimeState(baseDir, 1);
      const at = ["--base-dir", baseDir];

      const invited = parse<{ member: TeamMember; credential: string; pairUrl?: string }>(
        yield* captureStdout(
          runCli([
            "member",
            "invite",
            "Alice",
            "--git-email",
            "alice@example.com",
            "--github",
            "@alice-gh",
            ...at,
            "--json",
          ]),
        ),
      );
      assert.equal(invited.member.role, "member");
      assert.equal(invited.member.gitEmail, "alice@example.com");
      assert.deepEqual(invited.member.github, { login: "alice-gh", connected: false });
      assert.isString(invited.credential);
      assert.isUndefined(invited.pairUrl);

      const withUrl = parse<{ credential: string; pairUrl: string }>(
        yield* captureStdout(
          runCli([
            "member",
            "signin-link",
            "alice",
            ...at,
            "--base-url",
            "https://t3.example",
            "--json",
          ]),
        ),
      );
      assert.equal(withUrl.pairUrl, `https://t3.example/pair#token=${withUrl.credential}`);

      yield* runCli(["member", "invite", "Bob", ...at]);
      yield* runCli(["member", "invite", "bob", "--role", "admin", ...at]);
      const ambiguous = yield* runCli(["member", "remove", "BOB", ...at]).pipe(Effect.flip);
      assert.include(ambiguous.message, "Several members are named 'BOB'");

      const removed = yield* captureStdout(runCli(["member", "remove", "ALICE", ...at]));
      assert.include(removed, `Removed Alice ${invited.member.id}.`);

      const members = parse<ReadonlyArray<TeamMember>>(
        yield* captureStdout(runCli(["member", "list", ...at, "--json"])),
      );
      assert.sameDeepMembers(
        members
          .filter((member) => !member.isOwner)
          .map((member) => [member.name, member.removedAt !== null]),
        [
          ["Alice", true],
          ["Bob", false],
          ["bob", false],
        ],
      );
      const table = yield* captureStdout(runCli(["member", "list", ...at]));
      assert.match(table, new RegExp(`${invited.member.id}\\s+Alice\\s+member\\s+removed`));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("routes membership changes through a running server", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const calls: Array<string> = [];
      const port = yield* serveTeam(calls);
      yield* writeRuntimeState(baseDir, port);
      const at = ["--base-dir", baseDir];

      // remote-alice exists only on the server, so resolving her proves the list came from it.
      const removed = yield* captureStdout(runCli(["member", "remove", "alice", ...at]));
      assert.include(removed, "Removed Alice remote-alice.");

      const invited = parse<{ pairUrl: string }>(
        yield* captureStdout(
          runCli(["member", "invite", "Carol", "--role", "admin", ...at, "--json"]),
        ),
      );
      assert.equal(invited.pairUrl, `http://127.0.0.1:${port}/pair#token=REMOTECODE`);
      assert.deepEqual(calls, ["remove remote-alice", "invite Carol admin"]);

      const local = parse<ReadonlyArray<unknown>>(
        yield* captureStdout(runCli(["auth", "session", "list", ...at, "--json"])),
      );
      assert.deepEqual(local, [], "the CLI's temporary server session is revoked");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("--member", () => {
  it.effect("binds an issued session to the member's role and refuses wider scopes", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const at = ["--base-dir", baseDir];
      const invited = parse<{ member: TeamMember }>(
        yield* captureStdout(runCli(["member", "invite", "Alice", ...at, "--json"])),
      );
      const issue = (...args: ReadonlyArray<string>) =>
        runCli(["auth", "session", "issue", ...at, "--json", ...args]);

      const session = parse<{ sessionId: string; scopes: ReadonlyArray<string> }>(
        yield* captureStdout(issue("--member", "alice")),
      );
      assert.deepEqual(session.scopes, MEMBER_SCOPES);
      const narrowed = parse<{ scopes: ReadonlyArray<string> }>(
        yield* captureStdout(issue("--member", "alice", "--scope", "orchestration:read")),
      );
      assert.deepEqual(narrowed.scopes, ["orchestration:read"]);
      const owner = parse<{ scopes: ReadonlyArray<string> }>(yield* captureStdout(issue()));
      assert.deepEqual(owner.scopes, ADMIN_SCOPES);

      const wider = yield* issue("--member", "alice", "--scope", "settings:write").pipe(
        Effect.flip,
      );
      assert.equal(wider.message, "Alice's role (member) does not grant settings:write.");

      // Removing the member revokes the session, which shows it was bound to her.
      yield* runCli(["member", "remove", "Alice", ...at]);
      const remaining = parse<ReadonlyArray<{ sessionId: string }>>(
        yield* captureStdout(runCli(["auth", "session", "list", ...at, "--json"])),
      );
      assert.notInclude(
        remaining.map((listed) => listed.sessionId),
        session.sessionId,
      );
      const byId = yield* issue("--member", invited.member.id).pipe(Effect.flip);
      assert.equal(byId.message, `Member '${invited.member.id}' was removed.`);
      const byName = yield* issue("--member", "alice").pipe(Effect.flip);
      assert.include(byName.message, "No member matches 'alice'");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
