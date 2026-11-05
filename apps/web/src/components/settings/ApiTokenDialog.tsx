import {
  AuthAccessReadScope,
  AuthMcpClientAccess,
  mcpClientScopes,
  type AuthApiTokenResult,
  type AuthCreateApiTokenInput,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { environmentMcpUrl } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { KeyRoundIcon } from "lucide-react";
import { useId, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { authEnvironment } from "~/state/auth";
import { useEnvironment, useRelayEnvironmentDiscovery } from "~/state/environments";
import { readEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { LinkAccessPicker } from "./LinkAccessPicker";

type ExpiresInDays = NonNullable<AuthCreateApiTokenInput["expiresInDays"]>;
const EXPIRY_OPTIONS: ReadonlyArray<ExpiresInDays> = [30, 90, 365];
const DEFAULT_ACCESS: AuthMcpClientAccess = "approval-required";

/** Issues an API token for the caller; the token lives only in this dialog's state. */
export function CreateApiTokenButton({
  environmentId,
  delegatableScopes,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const createApiToken = useAtomCommand(authEnvironment.createApiToken, { reportFailure: false });
  const accessOptions = AuthMcpClientAccess.literals.filter((level) =>
    mcpClientScopes(level).every((scope) => delegatableScopes.includes(scope)),
  );
  const defaultAccess = accessOptions.includes(DEFAULT_ACCESS)
    ? DEFAULT_ACCESS
    : (accessOptions[0] ?? "read-only");
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>(defaultAccess);
  const [expiresInDays, setExpiresInDays] = useState<ExpiresInDays>(90);
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<AuthApiTokenResult | null>(null);
  const expiresLabelId = useId();

  const reset = () => {
    setLabel("");
    setAccess(defaultAccess);
    setExpiresInDays(90);
    setCreated(null);
  };

  const handleCreate = async () => {
    const trimmedLabel = label.trim();
    if (trimmedLabel === "" || !readEnvironmentScope(environmentId, AuthAccessReadScope)) return;
    setIsCreating(true);
    const result = await createApiToken({
      environmentId,
      input: { label: trimmedLabel, access, expiresInDays },
    });
    if (result._tag === "Success") {
      setCreated(result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't create API token",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
    setIsCreating(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            <KeyRoundIcon className="size-3" />
            Create API token
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            For scripts, CI and agents that connect over MCP. It acts as you, with at most the
            access you choose.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <DialogPanel>
              <CreatedApiToken environmentId={environmentId} token={created.token} />
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogPanel>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
                <Input
                  value={label}
                  maxLength={100}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. CI"
                  disabled={isCreating}
                  autoFocus
                />
              </label>
              <LinkAccessPicker
                value={access}
                onChange={setAccess}
                disabled={isCreating}
                label="Access"
                options={accessOptions}
                note="A token never gets more access than you have."
              />
              <div className="space-y-1.5">
                <span id={expiresLabelId} className="block text-xs font-medium">
                  Expires
                </span>
                <Select
                  value={String(expiresInDays)}
                  disabled={isCreating}
                  onValueChange={(next) => {
                    const days = EXPIRY_OPTIONS.find((option) => String(option) === next);
                    if (days !== undefined) setExpiresInDays(days);
                  }}
                >
                  <SelectTrigger aria-labelledby={expiresLabelId}>
                    <SelectValue>{`In ${expiresInDays} days`}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {EXPIRY_OPTIONS.map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {`In ${days} days`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={isCreating} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={isCreating || label.trim() === ""}
                onClick={() => void handleCreate()}
              >
                {isCreating ? "Creating…" : "Create token"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CreatedApiToken({
  environmentId,
  token,
}: {
  readonly environmentId: EnvironmentId;
  readonly token: string;
}) {
  const environment = useEnvironment(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const mcpUrl = environment
    ? environmentMcpUrl({
        entry: environment.entry,
        relayHttpBaseUrl:
          relayDiscovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl,
        connectedTarget: prepared._tag === "Some" ? prepared.value.target : null,
      })
    : null;
  const mcpOrigin = mcpUrl ? new URL(mcpUrl) : null;
  const sniffable =
    mcpOrigin !== null && mcpOrigin.protocol === "http:" && !isLoopbackHost(mcpOrigin.hostname);
  const { copyToClipboard } = useCopyToClipboard<{ what: string }>({
    target: "API token",
    onCopy: ({ what }) => toastManager.add({ type: "success", title: `${what} copied` }),
    onError: (error, { what }) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${what.toLowerCase()}`,
          description: error.message,
        }),
      ),
  });
  const snippets = mcpUrl
    ? [
        {
          what: "Claude Code command",
          text: `claude mcp add --transport http t3 ${mcpUrl} --header "Authorization: Bearer $T3CODE_TOKEN"`,
        },
        {
          what: "CLI command",
          text: `T3CODE_URL=${mcpOrigin!.origin} T3CODE_TOKEN=… npx t3 thread start <project> "…"`,
        },
      ]
    : [];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label="API token"
            value={token}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => copyToClipboard(token, { what: "API token" })}
          >
            Copy
          </Button>
        </div>
        <p className="text-xs text-warning">Shown once. Anyone with this token can act as you.</p>
        {sniffable ? (
          <p className="text-xs text-warning">
            This address is plain http, so the token can be read on the network. Use https outside a
            network you trust.
          </p>
        ) : null}
      </div>
      {snippets.map(({ what, text }) => (
        <div key={what} className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{what}</span>
            <Button size="xs" variant="ghost" onClick={() => copyToClipboard(text, { what })}>
              Copy
            </Button>
          </div>
          <Textarea
            readOnly
            aria-label={what}
            value={text}
            rows={2}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ))}
    </div>
  );
}
