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
