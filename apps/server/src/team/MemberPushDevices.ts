import {
  type AuthSessionId,
  type MemberId,
  MemberPushError,
  type MemberPushPlatform,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export interface MemberPushDevice {
  readonly memberId: MemberId;
  readonly token: string;
}

/** Expo push tokens per device, each tied to the auth session that registered it. */
export class MemberPushDevices extends Context.Service<
  MemberPushDevices,
  {
    /** Upserts by device id, so a device that signs in as another member moves to them. */
    readonly register: (input: {
      readonly memberId: MemberId;
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
      readonly token: string;
      readonly platform: MemberPushPlatform;
    }) => Effect.Effect<void, MemberPushError>;
    readonly unregister: (input: {
      readonly memberId: MemberId;
      readonly deviceId: string;
    }) => Effect.Effect<void, MemberPushError>;
    readonly removeMember: (memberId: MemberId) => Effect.Effect<void>;
    readonly removeSession: (sessionId: AuthSessionId) => Effect.Effect<void>;
    readonly removeToken: (token: string) => Effect.Effect<void>;
    /** Deletes rows whose session was revoked or expired, then lists the rest. */
    readonly listLive: Effect.Effect<ReadonlyArray<MemberPushDevice>>;
  }
>()("t3/team/MemberPushDevices") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const failWith = (message: string) => (cause: unknown) =>
    Effect.logError(message, { cause }).pipe(
      Effect.andThen(Effect.fail(new MemberPushError({ message }))),
    );
  const logOnly = (message: string) => (cause: unknown) => Effect.logWarning(message, { cause });

  const register: MemberPushDevices["Service"]["register"] = Effect.fn(
    "MemberPushDevices.register",
  )(function* (input) {
    const updatedAt = yield* now;
    yield* sql`
        INSERT INTO member_push_devices (device_id, member_id, session_id, token, platform, updated_at)
        VALUES (${input.deviceId}, ${input.memberId}, ${input.sessionId}, ${input.token}, ${input.platform}, ${updatedAt})
        ON CONFLICT (device_id) DO UPDATE SET
          member_id = excluded.member_id,
          session_id = excluded.session_id,
          token = excluded.token,
          platform = excluded.platform,
          updated_at = excluded.updated_at
      `.pipe(Effect.catch(failWith("Could not register this device for push notifications.")));
  });

  const unregister: MemberPushDevices["Service"]["unregister"] = Effect.fn(
    "MemberPushDevices.unregister",
  )(function* (input) {
    yield* sql`
      DELETE FROM member_push_devices
      WHERE device_id = ${input.deviceId} AND member_id = ${input.memberId}
    `.pipe(Effect.catch(failWith("Could not unregister this device from push notifications.")));
  });

  const removeMember: MemberPushDevices["Service"]["removeMember"] = Effect.fn(
    "MemberPushDevices.removeMember",
  )(function* (memberId) {
    yield* sql`DELETE FROM member_push_devices WHERE member_id = ${memberId}`.pipe(
      Effect.catch(logOnly("Could not delete a removed member's push devices.")),
    );
  });

  const removeSession: MemberPushDevices["Service"]["removeSession"] = Effect.fn(
    "MemberPushDevices.removeSession",
  )(function* (sessionId) {
    yield* sql`DELETE FROM member_push_devices WHERE session_id = ${sessionId}`.pipe(
      Effect.catch(logOnly("Could not delete a revoked session's push devices.")),
    );
  });

  const removeToken: MemberPushDevices["Service"]["removeToken"] = Effect.fn(
    "MemberPushDevices.removeToken",
  )(function* (token) {
    yield* sql`DELETE FROM member_push_devices WHERE token = ${token}`.pipe(
      Effect.catch(logOnly("Could not delete an unregistered push token.")),
    );
  });

  const listLive: MemberPushDevices["Service"]["listLive"] = Effect.gen(function* () {
    const at = yield* now;
    yield* sql`
      DELETE FROM member_push_devices
      WHERE NOT EXISTS (
        SELECT 1 FROM auth_sessions
        WHERE auth_sessions.session_id = member_push_devices.session_id
          AND auth_sessions.revoked_at IS NULL
          AND auth_sessions.expires_at > ${at}
      )
    `;
    return yield* sql<MemberPushDevice>`
      SELECT member_id AS "memberId", token FROM member_push_devices ORDER BY member_id, device_id
    `;
  }).pipe(
    Effect.catch((cause) =>
      logOnly("Could not read push devices.")(cause).pipe(Effect.as([] as const)),
    ),
    Effect.withSpan("MemberPushDevices.listLive"),
  );

  return MemberPushDevices.of({
    register,
    unregister,
    removeMember,
    removeSession,
    removeToken,
    listLive,
  });
});

export const layer = Layer.effect(MemberPushDevices, make);
