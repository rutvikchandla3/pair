import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

/** A signed-in, enabled provider snapshot; with no `models` it takes any model id. */
export const readyProvider = (
  instanceId: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: instanceId.split("-")[0],
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as unknown as ServerProvider;
