import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { SandboxBootstrap } from "./ComputeDriver.ts";

const CLOUD_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** A cloud resource name for `name` (lowercase, `-` for `_:.`), or null when it can't be one. */
export const cloudSafeName = (name: string): string | null => {
  const mapped = name.toLowerCase().replace(/[_:.]/g, "-");
  return CLOUD_NAME.test(mapped) ? mapped : null;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A VM's `bootstrap.env`, as Docker's lines. Null when a value holds a line break or the runner
 * URL is not http(s), since a VM cannot dial the server's socket.
 */
export const vmBootstrapText = (bootstrap: SandboxBootstrap): string | null => {
  if (!/^https?:\/\//.test(bootstrap.serverUrl)) return null;
  const values = {
    PAIR_RUNNER_URL: bootstrap.serverUrl,
    PAIR_SANDBOX_ID: bootstrap.sandboxId,
    PAIR_RUNNER_BUILD: bootstrap.runnerBuildId,
    PAIR_RUNNER_ENROLL: Redacted.value(bootstrap.enrollmentSecret),
  };
  if (Object.values(values).some((value) => /[\0\n\r]/.test(value))) return null;
  return Object.entries(values)
    .map(([name, value]) => `${name}=${shellQuote(value)}\n`)
    .join("");
};

/**
 * `t3-team-image:14` is `pair-<install8>-team-image-14` in family `pair-<install8>-team-image`;
 * null when the name has no `:<build>` or does not fit a resource name.
 */
export const teamImageName = (
  installId: EnvironmentId,
  snapshotName: string,
): { readonly name: string; readonly family: string; readonly build: string } | null => {
  const colon = snapshotName.lastIndexOf(":");
  if (colon <= 0) return null;
  const family = cloudSafeName(
    `pair-${installId.slice(0, 8)}-${snapshotName.slice(0, colon).replace(/^t3-/, "")}`,
  );
  const build = cloudSafeName(`b${snapshotName.slice(colon + 1)}`)?.slice(1);
  const name = family === null || build === undefined ? null : cloudSafeName(`${family}-${build}`);
  return name === null || family === null || build === undefined ? null : { name, family, build };
};

// node:http, not undici: a single executable cannot import the undici the server keeps external.
export const nodeHttpClient = NodeHttpClient.makeAgent(undefined).pipe(
  Effect.flatMap((agent) =>
    NodeHttpClient.makeNodeHttp.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agent)),
  ),
);
