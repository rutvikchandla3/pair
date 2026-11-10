import {
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import { describe as effectDescribe, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyTeamImageLogChunk,
  createTeamImageAtoms,
  EMPTY_TEAM_IMAGE_LOG,
  TEAM_IMAGE_LOG_VIEW_MAX_CHARS,
} from "./teamImage.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const env = EnvironmentId.make("cloud");
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSettingsWriteScope],
      permissions: [AuthSettingsWriteScope],
    }),
  ),
);

describe("applyTeamImageLogChunk", () => {
  it("appends chunks and ends with the done flag", () => {
    const first = applyTeamImageLogChunk(EMPTY_TEAM_IMAGE_LOG, { text: "one\n", done: false });
    const last = applyTeamImageLogChunk(first, { text: "two\n", done: true });
    expect(last).toEqual({ text: "one\ntwo\n", done: true, truncated: false });
  });

  it("drops the oldest lines past the cap and starts on a whole line", () => {
    const line = `${"x".repeat(99)}\n`;
    const full = line.repeat(Math.ceil(TEAM_IMAGE_LOG_VIEW_MAX_CHARS / 100) + 5);
    const view = applyTeamImageLogChunk(EMPTY_TEAM_IMAGE_LOG, { text: full, done: false });
    expect(view.truncated).toBe(true);
    expect(view.text.length).toBeLessThanOrEqual(TEAM_IMAGE_LOG_VIEW_MAX_CHARS);
    expect(view.text.startsWith(line)).toBe(true);
  });
});

effectDescribe("saveAndBuild", () => {
  effectIt.effect("builds the revision the save returned, not the one the editor held", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const session = {
        client: {
          [WS_METHODS.teamImageSaveRecipe]: (input: unknown) =>
            Effect.sync(() => {
              calls.push(["save", input]);
              return { revision: 8 };
            }),
          [WS_METHODS.teamImageStartBuild]: (input: unknown) =>
            Effect.sync(() => {
              calls.push(["build", input]);
              return { id: "tib_00000000000000000001" };
            }),
        },
      } as unknown as RpcSession;
      const supervisor = {
        target: { environmentId: env, label: "cloud" },
        session: yield* SubscriptionRef.make(Option.some(session)),
      } as unknown as EnvironmentSupervisor["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry, {
          run: (_id: EnvironmentId, effect: Effect.Effect<unknown, never, EnvironmentSupervisor>) =>
            effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
        } as unknown as EnvironmentRegistry["Service"]),
      );
      const registry = AtomRegistry.make();
      registry.mount(sessions(env));
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const { saveAndBuild } = createTeamImageAtoms(runtime);
      const input = {
        baseRevision: 7,
        recipe: {
          base: { type: "pair" },
          projectIds: [],
          buildEnv: {},
          buildSecrets: {},
          install: "",
        },
      } as const;
      const result = yield* Effect.promise(() =>
        saveAndBuild.run(registry, { environmentId: env, input }),
      );
      expect(result._tag).toBe("Success");
      expect(calls).toEqual([
        ["save", input],
        ["build", { recipeRevision: 8 }],
      ]);
    }).pipe(Effect.scoped),
  );
});
