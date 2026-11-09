import { ComputeDriverId, type SandboxDriverInstance } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";

/** Settings → Cloud exists on a cloud-only server, and elsewhere while drivers remain to remove. */
export function cloudSettingsVisible(serverConfig: EnvironmentServerConfig | null): boolean {
  return (
    serverConfig?.environment.capabilities.cloudLaunch === true ||
    (serverConfig?.settings.sandbox?.drivers.length ?? 0) > 0
  );
}

/** A Docker host other than a local socket cannot reach this server's disk (03 §3.2). */
export function isRemoteDockerHost(dockerHost: string): boolean {
  const host = dockerHost.trim();
  return host !== "" && !host.startsWith("unix://");
}

export function dockerDriverFormError(input: {
  readonly label: string;
  readonly dockerHost: string;
  readonly runnerUrl: string;
  /** Empty is the driver's default. */
  readonly runningCap: string;
}): string | null {
  const host = input.dockerHost.trim();
  const runnerUrl = input.runnerUrl.trim();
  const runningCap = input.runningCap.trim();
  if (input.label.trim() === "") return "Name the driver.";
  if (host.startsWith("ssh://"))
    return "Docker over ssh:// is not supported. Forward the socket and use unix://.";
  if (host !== "" && !/^(unix|tcp):\/\/./.test(host))
    return "Use a unix:// socket or a tcp:// address.";
  if (isRemoteDockerHost(host) && runnerUrl === "")
    return "A remote Docker host needs a runner URL: an address of this server its machines can reach.";
  if (runnerUrl !== "" && !/^https?:\/\/./.test(runnerUrl))
    return "The runner URL must start with http:// or https://.";
  if (runningCap !== "" && !/^[1-9]\d*$/.test(runningCap))
    return "Enter a whole number of machines, 1 or more.";
  return null;
}

export function nextDriverId(drivers: ReadonlyArray<SandboxDriverInstance>): ComputeDriverId {
  const taken = new Set<string>(drivers.map((driver) => driver.id));
  let index = 1;
  while (taken.has(index === 1 ? "docker" : `docker-${index}`)) index += 1;
  return ComputeDriverId.make(index === 1 ? "docker" : `docker-${index}`);
}
