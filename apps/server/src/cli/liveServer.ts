import {
  ADMIN_SCOPES,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

const layerLiveProtocol = (socketUrl: string) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(socketUrl).pipe(
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
        ),
        RpcSerialization.layerJson,
      ),
    ),
  );

/**
 * An admin RPC client for the server running from this state directory, or none when no server
 * runs. Its session is revoked when the scope closes.
 */
export const connectLiveServer = Effect.fn("cli.connectLiveServer")(function* (
  statePath: string,
  label: string,
) {
  const state = yield* readPersistedServerRuntimeState(statePath);
  if (Option.isNone(state) || !isProcessAlive(state.value.pid)) return Option.none();
  const origin = state.value.origin;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* Effect.acquireRelease(
    environmentAuth.issueSession({ scopes: ADMIN_SCOPES, label }),
    (session) =>
      environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
  );
  const ticket = yield* environmentAuth.issueWebSocketTicket(
    { sessionId: issued.sessionId },
    { use: "rpc" },
  );
  const socketUrl = new URL("/ws", origin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("wsTicket", Redacted.value(ticket.ticket));
  socketUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  const protocol = yield* Layer.build(layerLiveProtocol(socketUrl.href));
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
  return Option.some({ client, origin, state: state.value });
});
