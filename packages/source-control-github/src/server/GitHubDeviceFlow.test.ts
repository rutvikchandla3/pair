import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubDeviceFlow from "./GitHubDeviceFlow.ts";

const flowAnswering = (status: number, body: unknown) => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const httpClient = HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers["authorization"] });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  return { flow: GitHubDeviceFlow.make({ httpClient, clientId: "Iv-test-client" }), requests };
};

describe("GitHubDeviceFlow.viewer", () => {
  it.effect("reads the account a token acts as, and null when GitHub refuses the token", () =>
    Effect.gen(function* () {
      const signedIn = flowAnswering(200, { id: 42, login: "octocat", name: "The Octocat" });
      expect(yield* signedIn.flow.viewer("github.com", "ghu_member")).toEqual({
        id: 42,
        login: "octocat",
      });
      expect(signedIn.requests).toEqual([
        { url: "https://api.github.com/user", authorization: "Bearer ghu_member" },
      ]);

      const refused = flowAnswering(401, { message: "Bad credentials" });
      expect(yield* refused.flow.viewer("github.com", "ghu_revoked")).toBeNull();

      const failing = flowAnswering(502, {});
      expect((yield* Effect.flip(failing.flow.viewer("github.com", "ghu_member")))._tag).toBe(
        "GitHubDeviceFlowError",
      );
    }),
  );
});

describe("GitHubDeviceFlow.requestCode", () => {
  it.effect.each([
    {
      name: "Device Flow is off when GitHub refuses the code with device_flow_disabled",
      status: 400,
      body: {
        error: "device_flow_disabled",
        error_description: "Device Flow must be explicitly enabled for this App",
      },
      detail:
        "This server's GitHub App has Device Flow off. An admin can tick Enable Device Flow in the App's settings on GitHub, then try again.",
    },
    {
      name: "GitHub can't be reached when it answers with a server error",
      status: 502,
      body: {},
      detail: "The server could not reach GitHub to start the sign-in.",
    },
  ])("says $name", ({ status, body, detail }) =>
    Effect.gen(function* () {
      const { flow } = flowAnswering(status, body);
      const error = yield* Effect.flip(flow.requestCode("github.com"));
      expect({ reason: error.reason, detail: error.detail }).toEqual({ reason: "failed", detail });
    }),
  );
});
