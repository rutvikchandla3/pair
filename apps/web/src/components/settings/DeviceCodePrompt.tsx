import type { SourceControlSignInPrompt } from "@t3tools/contracts";
import { Check, Copy } from "lucide";
import { ExternalLinkIcon } from "lucide-react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";

const expiryTime = (expiresAt: number) =>
  new Date(expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The device code, one cell per character, as GitHub prints it. */
function DeviceCode(props: { readonly code: string }) {
  return (
    <div className="flex items-center gap-1 font-mono text-lg font-medium">
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
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "sign-in code",
  });
  return (
    <div className="grid gap-4 border-t border-border bg-muted/40 px-3 py-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-6">
      <div className="flex items-center gap-2">
        <DeviceCode code={prompt.userCode} />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy code"
          onClick={() => copyToClipboard(prompt.userCode, undefined)}
        >
          <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
        </Button>
      </div>
      <div className="grid gap-2 sm:justify-items-end">
        <Button
          size="sm"
          render={<a href={prompt.verificationUri} target="_blank" rel="noreferrer noopener" />}
          onClick={() => copyToClipboard(prompt.userCode, undefined)}
        >
          Copy code & open GitHub
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </Button>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          Waiting for approval · code expires at {expiryTime(prompt.expiresAt)}
        </p>
      </div>
    </div>
  );
}
