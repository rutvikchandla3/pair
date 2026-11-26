import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import type { MFunctionType } from "gt-i18n/types";

import { resolveEnvironmentUrl } from "./environment/endpoint.ts";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
  _resolve?: MFunctionType,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Set the server's public URL or link T3 Connect for a public URL.",
    };
  }
  const url = new URL(resolveEnvironmentUrl(httpBaseUrl, endpoint.path));
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Set the server's public URL or link T3 Connect for a public URL."
      : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Set the server's public URL or link T3 Connect for a public URL.",
  };
}
