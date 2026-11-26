import type { SourceControlSignInPrompt } from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";

const expiryTime = (expiresAt: number) =>
  new Date(expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The device code, one cell per character, as GitHub prints it. */
function DeviceCode(props: { readonly code: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 font-mono text-lg font-medium">
      <span className="sr-only">{props.code}</span>
      {Array.from(props.code, (char, index) =>
        char === "-" ? (
          <span key={index} aria-hidden className="px-0.5 text-muted-foreground">
            –
          </span>
        ) : (
          <span
            key={index}
            aria-hidden
            className="grid h-10 w-8 place-items-center rounded-md border border-border bg-background shadow-xs"
          >
            {char}
          </span>
        ),
      )}
    </div>
  );
}

/** A GitHub device-flow code to copy, and the page to enter it on. */
export function DeviceCodePrompt({ prompt }: { readonly prompt: SourceControlSignInPrompt }) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "sign-in code",
      unavailableMessage: msg("Clipboard API is unavailable while copying sign-in code."),
      failureMessage: msg("Failed to copy sign-in code to the clipboard."),
    },
  });
  return (
    // Sized by its container: the /pair card is narrower than the `sm` viewport breakpoint implies.
    <div className="@container border-t border-border bg-muted/40 px-3 py-4">
      <div className="grid gap-4 @2xl:grid-cols-[auto_1fr] @2xl:items-center @2xl:gap-6">
        <div className="flex min-w-0 items-center gap-2">
          <DeviceCode code={prompt.userCode} />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Copy code")}
            onClick={() => copyToClipboard(prompt.userCode, undefined)}
          >
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        </div>
        <div className="grid gap-2 @2xl:justify-items-end">
          <Button
            size="sm"
            render={<a href={prompt.verificationUri} target="_blank" rel="noreferrer noopener" />}
            onClick={() => copyToClipboard(prompt.userCode, undefined)}
          >
            <T>Copy code & open GitHub</T>
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            <T>
              Waiting for approval · code expires at <Var>{expiryTime(prompt.expiresAt)}</Var>
            </T>
          </p>
        </div>
      </div>
    </div>
  );
}
