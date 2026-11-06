import { Alert, AlertDescription } from "../ui/alert";
import type { AuthGitHubSignInStarted, AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  pollGitHubSignIn,
  startGitHubSignIn,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { DeviceCodePrompt } from "../settings/DeviceCodePrompt";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Signing in to this environment"
        description="Checking your sign-in link and preparing your session."
      />
    </StandalonePage>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  hasReturnPath = false,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  /** The visitor was sent here from a link, so they need an account, not just this screen. */
  hasReturnPath?: boolean;
  onAuthenticated: () => void;
}) {
  const [autoPairToken] = useState(peekPairingTokenFromUrl);
  const [credential, setCredential] = useState(autoPairToken ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = async (nextCredential: string) => {
    setIsSubmitting(true);
    setErrorMessage("");

    const submitError = await submitServerAuthCredential(nextCredential).then(
      () => null,
      (error) => errorMessageFromUnknown(error),
    );

    setIsSubmitting(false);

    if (submitError) {
      setErrorMessage(submitError);
      return;
    }

    startTransition(() => {
      onAuthenticated();
    });
  };

  const handleSubmit = async (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    await submitCredential(credential);
  };

  const autoSubmit = useEffectEvent((token: string) => {
    void submitCredential(token);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the pairing token from the URL and submits it once when the route carries one
  useEffect(() => {
    if (!autoPairToken || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    autoSubmit(autoPairToken);
  }, [autoPairToken]);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Sign in to this environment"
        description={describeAuthGate(auth.bootstrapMethods)}
      />

      {hasReturnPath && !autoPairToken ? (
        <p className="mt-4 text-sm text-foreground">
          Ask an admin for an invite, or open your sign-in link.
        </p>
      ) : null}

      {auth.githubSignIn ? (
        <GitHubSignIn disabled={isSubmitting} onCredential={submitCredential} />
      ) : null}

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="pairing-token">
            Sign-in code
          </label>
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setCredential(event.currentTarget.value)}
            placeholder="Paste a one-time sign-in code"
            spellCheck={false}
            value={credential}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? "Signing in…" : "Continue"}
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload app
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </div>
    </StandalonePage>
  );
}

type GitHubSignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly prompt: AuthGitHubSignInStarted }
  | { readonly status: "failed"; readonly message: string };

const waitSeconds = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/** The GitHub device flow; its approval yields a one-time sign-in code for the form's own path. */
function GitHubSignIn({
  disabled,
  onCredential,
}: {
  readonly disabled: boolean;
  readonly onCredential: (credential: string) => Promise<void>;
}) {
  const [state, setState] = useState<GitHubSignInState>({ status: "idle" });
  // The attempt still being polled; clearing it stops the loop.
  const attemptRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops polling GitHub sign-in when the page goes away
  useEffect(
    () => () => {
      attemptRef.current = null;
    },
    [],
  );

  const signIn = async () => {
    setState({ status: "starting" });
    const started = await startGitHubSignIn().catch((error: unknown) => {
      setState({ status: "failed", message: errorMessageFromUnknown(error) });
      return null;
    });
    if (started === null) return;
    attemptRef.current = started.attemptId;
    setState({ status: "waiting", prompt: started });
    while (true) {
      await waitSeconds(started.interval);
      if (attemptRef.current !== started.attemptId) return;
      const result = await pollGitHubSignIn(started.attemptId).catch((error: unknown) => {
        attemptRef.current = null;
        setState({ status: "failed", message: errorMessageFromUnknown(error) });
        return null;
      });
      if (result === null || attemptRef.current !== started.attemptId) return;
      if (result.status === "complete") {
        attemptRef.current = null;
        setState({ status: "idle" });
        await onCredential(result.credential);
        return;
      }
    }
  };

  const cancel = () => {
    attemptRef.current = null;
    setState({ status: "idle" });
  };

  return (
    <div className="mt-6 space-y-3">
      {state.status === "waiting" ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-3 px-3 py-2">
            <p className="min-w-0 flex-1 text-sm text-foreground">
              Enter this code on GitHub to sign in.
            </p>
            <Button size="xs" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
          <DeviceCodePrompt prompt={state.prompt} />
        </div>
      ) : (
        <Button
          disabled={disabled || state.status === "starting"}
          onClick={() => void signIn()}
          size="sm"
          variant="outline"
        >
          {state.status === "starting" ? "Starting…" : "Sign in with GitHub"}
        </Button>
      )}
      {state.status === "failed" ? (
        <Alert variant="error">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const [request] = useState(readHostedPairingRequest);
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(
    request ? "pairing" : "error",
  );
  const [message, setMessage] = useState(
    request
      ? "Connecting to this backend."
      : "This sign-in link is missing its server address or code.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = async () => {
    if (!request) {
      setStatus("error");
      setMessage("This sign-in link is missing its server address or code.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This sign-in code was already used. Ask for a new sign-in link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "The environment"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the server accepted this one-time code, ask for a new sign-in link before retrying.`,
    );
  };

  const submitOnMount = useEffectEvent(() => {
    void submitHostedPairingRequest();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the pairing token from the URL and submits the hosted pairing request once on mount
  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    submitOnMount();
  }, []);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={
          status === "paired" ? "Connected" : status === "error" ? "Couldn't connect" : "Connecting"
        }
        description={message}
      />

      {request ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <Alert variant="error" className="mt-5">
          <AlertDescription>
            Verify the backend is reachable from this browser, supports CORS for hosted clients, and
            is served over HTTPS when opening this page from HTTPS.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" ? (
          <Button disabled size="sm">
            Connecting…
          </Button>
        ) : canRetry ? (
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
            Open app
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment needs a sign-in code before the app can connect.";
  }

  return "Enter a sign-in code to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "This environment accepts desktop sign-in and one-time sign-in codes.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time sign-in codes. A sign-in link opens this page directly, or you can paste the code here.";
}
