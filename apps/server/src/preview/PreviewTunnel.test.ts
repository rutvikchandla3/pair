import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  MemberId,
} from "@t3tools/contracts";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import type * as Members from "../persistence/Members.ts";
import * as TeamState from "../team/TeamState.ts";
import * as PreviewTunnel from "./PreviewTunnel.ts";

const listen = (onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeNet.Server; sockets: Set<NodeNet.Socket> }>((resolve) => {
          const sockets = new Set<NodeNet.Socket>();
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            onConnection(socket);
          });
          server.listen(0, "127.0.0.1", () => resolve({ server, sockets }));
        }),
    ),
    ({ server, sockets }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      ),
  ).pipe(Effect.map(({ server }) => ({ port: (server.address() as NodeNet.AddressInfo).port })));

const member = (id: string, isOwner: boolean): Members.MemberRecord => ({
  id: MemberId.make(id),
  name: id,
  role: isOwner ? "admin" : "member",
  gitName: null,
  gitEmail: null,
  isOwner,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});

/**
 * Serves the tunnel route; `wsTicket=reader` authenticates without terminal:operate and
 * `wsTicket=member` without access:write.
 */
const serveTunnel = (
  sessionInvalidated: Effect.Effect<void> = Effect.never,
  server: { readonly team?: boolean; readonly cloudOnly?: boolean } = {},
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(PreviewTunnel.routeLayer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(PreviewTunnel.layer),
        Layer.provide(
          TeamState.layerTest(
            server.team
              ? [member("member-owner", true), member("member-two", false)]
              : [member("member-owner", true)],
          ),
        ),
        Layer.provide(
          Layer.succeed(ServerConfig.ServerConfig, {
            cloudOnly: server.cloudOnly ?? false,
          } as ServerConfig.ServerConfig["Service"]),
        ),
        Layer.provide(
          Layer.mock(SessionStore.SessionStore, {
            cookieName: "t3_session",
            legacyCookieName: undefined,
            awaitInvalidation: () => sessionInvalidated,
          }),
        ),
        Layer.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: (request) =>
              Effect.succeed({
                sessionId: AuthSessionId.make("tunnel-test"),
                subject: "tunnel-test",
                method: "bearer-access-token",
                scopes: request.url.includes("wsTicket=reader")
                  ? [AuthOrchestrationReadScope]
                  : request.url.includes("wsTicket=member")
                    ? [AuthOrchestrationReadScope, AuthTerminalOperateScope]
                    : [AuthOrchestrationReadScope, AuthTerminalOperateScope, AuthAccessWriteScope],
              }),
          }),
        ),
      ),
    );
    const origin = new URL(
      HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address),
    );
    return { origin: `ws://${origin.host}`, port: Number(origin.port) };
  });

const openTunnel = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocket(url)),
    (socket) => Effect.sync(() => socket.terminate()),
  );

/** How the route turned down a tunnel: its status, and whether it marked the port as the reason. */
const refusal = (client: NodeWS.WebSocket) =>
  Effect.promise(
    () =>
      new Promise<{ status: number | undefined; portRefused: boolean }>((resolve, reject) => {
        client.on("unexpected-response", (_request, response) =>
          resolve({
            status: response.statusCode,
            portRefused:
              response.headers[PreviewTunnel.PREVIEW_TUNNEL_PORT_REFUSED_HEADER] !== undefined,
          }),
        );
        client.on("open", () => reject(new Error("tunnel opened")));
        client.on("error", reject);
      }),
  );

it.effect(
  "pipes bytes both ways for a team owner between the WebSocket and the loopback port",
  () =>
    Effect.gen(function* () {
      const upstreamReceived: number[] = [];
      const upstream = yield* listen((socket) => {
        socket.write(Uint8Array.of(0x10, 0x11));
        socket.on("data", (chunk) => {
          upstreamReceived.push(...chunk);
          socket.write(Buffer.concat([Uint8Array.of(0xee), chunk]));
        });
      });
      const tunnel = yield* serveTunnel(Effect.never, { team: true });
      const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
      const clientReceived: number[] = [];
      const done = Promise.withResolvers<void>();
      client.on("error", done.reject);
      client.on("message", (data: Buffer) => {
        clientReceived.push(...data);
        if (clientReceived.length === 2) client.send(Uint8Array.of(0x01, 0x02, 0x03));
        if (clientReceived.length === 6) done.resolve();
      });
      yield* Effect.promise(() => done.promise);
      expect(upstreamReceived).toEqual([0x01, 0x02, 0x03]);
      expect(clientReceived).toEqual([0x10, 0x11, 0xee, 0x01, 0x02, 0x03]);
    }),
);

it.effect.each([
  { case: "the server's own port", target: "self", ticket: "operator", portRefused: true },
  {
    case: "a session without terminal:operate",
    target: "listed",
    ticket: "reader",
    portRefused: false,
  },
  {
    case: "a team member who does not manage access",
    target: "listed",
    ticket: "member",
    portRefused: false,
    team: true,
  },
] as const)("refuses $case with 403 before dialling", (testCase) =>
  Effect.gen(function* () {
    let dialled = 0;
    const countDial = (socket: NodeNet.Socket) => {
      dialled++;
      socket.destroy();
    };
    const listed = yield* listen(countDial);
    const tunnel = yield* serveTunnel(Effect.never, { team: "team" in testCase });
    const port = { listed: listed.port, self: tunnel.port }[testCase.target];
    const client = yield* openTunnel(
      `${tunnel.origin}/api/preview/tunnel?port=${port}&wsTicket=${testCase.ticket}`,
    );
    const response = yield* refusal(client);
    expect(response).toEqual({ status: 403, portRefused: testCase.portRefused });
    expect(dialled).toBe(0);
  }),
);

it.effect("has no tunnel on a cloud-only server", () =>
  Effect.gen(function* () {
    const upstream = yield* listen((socket) => socket.destroy());
    const tunnel = yield* serveTunnel(Effect.never, { cloudOnly: true });
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
    expect(yield* refusal(client)).toEqual({ status: 404, portRefused: false });
  }),
);

it.effect("answers a port nothing listens on with 502, marked as about the port", () =>
  Effect.gen(function* () {
    const closed = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => {
          const server = NodeNet.createServer();
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as NodeNet.AddressInfo;
            server.close(() => resolve(port));
          });
        }),
    );
    const tunnel = yield* serveTunnel();
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${closed}`);
    const response = yield* refusal(client);
    expect(response).toEqual({ status: 502, portRefused: true });
  }),
);

it.effect("closes an open tunnel when its session is revoked", () =>
  Effect.gen(function* () {
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = yield* listen((socket) => socket.on("close", () => upstreamClosed.resolve()));
    const revoked = yield* Deferred.make<void>();
    const tunnel = yield* serveTunnel(Deferred.await(revoked));
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
    yield* Effect.promise(() => new Promise((resolve) => client.once("open", resolve)));
    const clientClosed = new Promise((resolve) => client.once("close", resolve));
    yield* Deferred.succeed(revoked, undefined);
    yield* Effect.promise(() => Promise.all([clientClosed, upstreamClosed.promise]));
  }),
);
