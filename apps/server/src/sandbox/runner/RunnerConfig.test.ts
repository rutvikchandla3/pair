import { assert, it } from "@effect/vitest";

import { imageEnvironmentFrom } from "./RunnerConfig.ts";

const env = { PATH: "/usr/bin", HOME: "/home/t3", PAIR_RUNNER_URL: "unix:/run/pair.sock" };

it.each([
  { name: "a base image", manifest: null, expected: { PATH: "/usr/bin", HOME: "/home/t3" } },
  {
    name: "a team build",
    manifest: JSON.stringify({
      imageEnv: { PATH: "/opt/tools/bin:/usr/bin", JAVA_HOME: "/opt/jdk", PAIR_SANDBOX_ID: "x" },
    }),
    expected: { PATH: "/opt/tools/bin:/usr/bin", HOME: "/home/t3", JAVA_HOME: "/opt/jdk" },
  },
  { name: "a broken manifest", manifest: "{", expected: { PATH: "/usr/bin", HOME: "/home/t3" } },
])("the image environment of $name", ({ manifest, expected }) => {
  assert.deepEqual(imageEnvironmentFrom(env, manifest), expected);
});
