import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import type { AuthSessionState } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import * as PrimaryEnvironmentHttpClient from "../../environments/primary/httpClient";
import { __setPrimaryHttpRunnerForTests } from "../../lib/runtime";
import { PairingRouteSurface } from "./PairingRouteSurface";

const AUTH: AuthSessionState["auth"] = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
};

/** Sends the primary environment's HTTP through whatever `window.fetch` is at call time. */
function primaryHttpThroughWindowFetch(): AsyncDisposable {
  const runtime = ManagedRuntime.make(
    PrimaryEnvironmentHttpClient.layer.pipe(
      Layer.provide(layerRemoteHttpClient((input, init) => window.fetch(input, init))),
    ),
  );
  __setPrimaryHttpRunnerForTests((effect) => runtime.runPromise(effect));
  return {
    [Symbol.asyncDispose]: async () => {
      __setPrimaryHttpRunnerForTests();
      await runtime.dispose();
    },
  };
}

describe("PairingRouteSurface", () => {
  it("offers only the sign-in code when the server has no GitHub sign-in", async () => {
    await using screen = await render(
      <PairingRouteSurface auth={AUTH} onAuthenticated={() => undefined} />,
    );

    await expect.element(screen.getByLabelText("Sign-in code")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Sign in with GitHub" }))
      .not.toBeInTheDocument();
  });

  it("starts GitHub sign-in and shows the device code to enter", async () => {
    await using _http = primaryHttpThroughWindowFetch();
    using fetchSpy = vi.spyOn(window, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/api/auth/github/start")
        ? Response.json({
            attemptId: "attempt-1",
            userCode: "WDJB-MJHT",
            verificationUri: "https://github.com/login/device",
            expiresAt: 4_102_444_800_000,
            interval: 5,
          })
        : Response.json({ status: "pending" }),
    );
    await using screen = await render(
      <PairingRouteSurface auth={{ ...AUTH, githubSignIn: true }} onAuthenticated={() => undefined} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));

    await expect.element(screen.getByText("WDJB-MJHT")).toBeInTheDocument();
    await expect
      .element(screen.getByRole("link", { name: "Copy code & open GitHub" }))
      .toHaveAttribute("href", "https://github.com/login/device");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/auth/github/start");
    expect(init?.method).toBe("POST");
  });
});
