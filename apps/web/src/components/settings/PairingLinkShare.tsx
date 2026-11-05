import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { isLoopbackHostname } from "~/environments/primary";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  endpointDefaultPreferenceKey,
  endpointShareHint,
  isHostedAppPairingUrl,
  isQrShareableEndpoint,
  resolveAdvertisedEndpointPairingUrl,
  resolveCurrentOriginPairingUrl,
  selectPairingEndpoint,
  selectQrEndpointOption,
} from "./ConnectionsSettings.logic";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

export interface PairingLinkShareSource {
  readonly credential: string | undefined;
  /** Whether this page is served by the environment the link pairs with. */
  readonly servedByEnvironment: boolean;
  readonly endpointUrl: string | null | undefined;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
}

type CopyKind = "code" | "hosted-link" | "link";

export function usePairingLinkShare(
  {
    credential,
    servedByEnvironment,
    endpointUrl,
    endpoints,
    defaultEndpointKey,
  }: PairingLinkShareSource,
  onCopyFailed?: () => void,
) {
  const [qrEndpointId, setQrEndpointId] = useState<string | null>(null);
  const [failedCopyValue, setFailedCopyValue] = useState<string | null>(null);

  const currentOriginPairingUrl = credential ? resolveCurrentOriginPairingUrl(credential) : null;
  const hostedPairingUrl =
    credential && endpointUrl != null && endpointUrl !== ""
      ? resolveHostedPairingUrl(endpointUrl, credential)
      : null;
  const endpointPairingUrl = (() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint && credential
      ? resolveAdvertisedEndpointPairingUrl(endpoint, credential)
      : null;
  })();
  const endpointCopyOptions = (() => {
    const options: Array<{
      readonly id: string;
      readonly preferenceKey: string;
      readonly label: string;
      readonly url: string;
      readonly detail: string;
      readonly qrShareable: boolean;
    }> = [];
    if (!credential) return options;
    for (const endpoint of endpoints) {
      if (endpoint.status === "unavailable") {
        continue;
      }
      const url = resolveAdvertisedEndpointPairingUrl(endpoint, credential);
      options.push({
        id: endpoint.id,
        preferenceKey: endpointDefaultPreferenceKey(endpoint),
        label: endpoint.label,
        url,
        detail: endpointShareHint(endpoint, url),
        qrShareable: isQrShareableEndpoint(endpoint),
      });
    }
    return options;
  })();
  const shareablePairingUrl =
    endpointPairingUrl ??
    (credential && endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, credential))
      : !servedByEnvironment || isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  const revealValue = failedCopyValue ?? shareablePairingUrl ?? credential ?? "";
  const isRevealValueUrl = revealValue !== credential;
  const isRevealValueHostedAppPairingUrl = isRevealValueUrl && isHostedAppPairingUrl(revealValue);
  const isRevealValueQrShareable =
    endpointCopyOptions.find((option) => option.url === revealValue)?.qrShareable ?? true;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard } = useCopyToClipboard<{ value: string; kind: CopyKind }>({
    onCopy: ({ kind }) => {
      toastManager.add({
        type: "success",
        title:
          kind === "hosted-link"
            ? "Hosted app link copied"
            : kind === "link"
              ? "Sign-in link copied"
              : "Sign-in code copied",
        description:
          kind === "hosted-link"
            ? "Open it in the browser on the device you want to connect."
            : kind === "link"
              ? "Open it on the device you want to sign in."
              : "Paste it into another client to finish signing in.",
      });
    },
    onError: (error, { value, kind }) => {
      // Captured per attempt so concurrent copies cannot make the dialog
      // reveal a different value than the one that failed.
      setFailedCopyValue(value);
      onCopyFailed?.();
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "hosted-link"
              ? "Could not copy hosted app link"
              : kind === "link"
                ? "Couldn't copy sign-in link"
                : "Couldn't copy sign-in code"
            : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const copyPairingValue = (value: string, kind: CopyKind) => {
    copyToClipboard(value, { value, kind });
  };
  const selectedQrOption = selectQrEndpointOption(
    endpointCopyOptions,
    qrEndpointId,
    defaultEndpointKey,
  );

  return {
    endpointCopyOptions,
    shareablePairingUrl,
    canCopyToClipboard,
    revealValue,
    isRevealValueUrl,
    isRevealValueHostedAppPairingUrl,
    isRevealValueQrShareable,
    clearFailedCopy: () => setFailedCopyValue(null),
    copyCode: () => {
      if (credential) copyPairingValue(credential, "code");
    },
    copyLink: (url: string) =>
      copyPairingValue(url, isHostedAppPairingUrl(url) ? "hosted-link" : "link"),
    selectedQrOption,
    qrPairingUrl: selectedQrOption?.url ?? shareablePairingUrl,
    canRenderQrForSelection: selectedQrOption?.qrShareable ?? true,
    setQrEndpointId,
  };
}

export type PairingLinkShareState = ReturnType<typeof usePairingLinkShare>;

export function PairingLinkShare({
  share,
  className,
  ...rest
}: {
  readonly share: PairingLinkShareState;
  readonly className?: string;
  readonly id?: string;
}) {
  const { qrPairingUrl, selectedQrOption, endpointCopyOptions, canCopyToClipboard } = share;
  if (qrPairingUrl === null) return null;
  return (
    <div
      {...rest}
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}
    >
      <div className="min-w-0 flex-1 space-y-3">
        {endpointCopyOptions.length > 1 ? (
          <div
            className="space-y-1.5"
            role="radiogroup"
            aria-label="Endpoint the sign-in QR code and link use"
          >
            <p className="text-2xs text-muted-foreground/70">Reach this machine via</p>
            {endpointCopyOptions.map((option) => {
              const isSelected = option.id === selectedQrOption?.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    isSelected
                      ? "border-foreground/60 bg-muted/30"
                      : "border-border/50 hover:bg-muted/20",
                  )}
                  onClick={() => share.setQrEndpointId(option.id)}
                >
                  <span
                    className={cn(
                      "text-xs font-medium",
                      isSelected ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {option.label}
                  </span>
                  <span className="min-w-0 truncate text-2xs text-muted-foreground/70">
                    {option.detail}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {canCopyToClipboard ? (
          <>
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                      {qrPairingUrl}
                    </code>
                  }
                />
                <TooltipPopup side="top">{qrPairingUrl}</TooltipPopup>
              </Tooltip>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                onClick={() => share.copyLink(qrPairingUrl)}
              >
                Copy link
              </Button>
            </div>
            <Button size="xs" variant="ghost" onClick={share.copyCode}>
              Copy code only
            </Button>
          </>
        ) : (
          <Textarea
            readOnly
            aria-label="Sign-in link"
            value={qrPairingUrl}
            rows={4}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
        )}
      </div>
      {share.canRenderQrForSelection ? (
        <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
          <QRCodeSvg
            value={qrPairingUrl}
            size={168}
            level="M"
            marginSize={1}
            title="Sign-in link. Scan to open on another device"
          />
        </div>
      ) : (
        <div className="flex size-[192px] shrink-0 items-center justify-center self-center rounded-xl border border-border/50 p-4 sm:self-start">
          <p className="text-center text-2xs text-muted-foreground/70">
            No QR for this endpoint. Another device scanning a loopback link would dial itself; copy
            the URL for use on this machine instead.
          </p>
        </div>
      )}
    </div>
  );
}
