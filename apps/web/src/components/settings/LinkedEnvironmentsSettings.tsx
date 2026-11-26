import { useAtomValue } from "@effect/atom-react";
import { ANOTHER_ADDRESS } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessReadScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLink,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  offersLinkedEnvironmentsAtom,
  peerLinkEnvironment,
  useLinkableMachines,
  useLinkMachine,
} from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSearchableSetting } from "./settingsSearch";

// Console log labels for the atom commands.
const UNLINK_COMMAND_LABEL = "unlink environment";
const LINK_COMMAND_LABEL = "link environment";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId, input: {} }),
    useMessages(),
  );
  // Links made outside this client bump nothing the shared list reads, so showing the panel
  // asks again. Listing probes every linked environment, too costly for a timer nobody asked for.
  // A list still loading counts as read now, so the next return to the window asks again.
  useLiveRefresh(
    () => {
      if (!links.isPending) links.refresh();
    },
    {
      key: `linked-environments:${environmentId}`,
      intervalMs: null,
      refreshOnShow: true,
    },
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const labs = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const search = searchableSetting("linked-environments");
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={canLink ? <LinkEnvironmentAction environmentId={environmentId} /> : null}
    >
      {links.error ? (
        <SettingsRow title={gt("Could not load linked environments")} description={links.error} />
      ) : !links.data ? (
        <SettingsRow title={gt("Loading linked environments…")} role="status" />
      ) : links.data.links.length === 0 ? (
        <SettingsRow
          title={gt("No linked environments")}
          description={
            labs
              ? // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
                "Link another machine running Pair, such as a VPS, so agents here can launch and drive threads there."
              : // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
                "Link Pair Cloud so you can move threads there and back, and agents here can start cloud threads there as you."
          }
        />
      ) : (
        links.data.links.map((link) => (
          <LinkedEnvironmentRow
            key={link.environmentId}
            environmentId={environmentId}
            link={link}
          />
        ))
      )}
    </SettingsSection>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: UNLINK_COMMAND_LABEL });
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Forget ${link.label}? Agents here stop working there. Revoke "Pair · …" in ${link.label}'s Sharing & access to end the session there too.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not forget the link"), String(squashAtomCommandFailure(result)));
    }
  };
  const status =
    health.kind === "expired"
      ? "Expired. Connect it again with a new sign-in code."
      : health.kind === "unreachable"
        ? (health.detail ?? gt("Not answering right now."))
        : health.kind === "failing"
          ? health.detail
          : health.expiresInDays !== null
            ? gt(
                "{days, plural, one {Expires in {days} day. Link it again to renew.} other {Expires in {days} days. Link it again to renew.}}",
                { days: health.expiresInDays },
              )
            : gt("Reachable");
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {m(accessConfig[link.access].label)} · {status}
          </p>
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
        </div>
        {canUnlink ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy ? gt("Forgetting…") : gt("Forget")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkEnvironmentAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const labs = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const linkable = useLinkableMachines(environmentId, open);
  // Without the Linked environments beta, only a link to Pair Cloud works.
  const machines = labs ? linkable : linkable.filter((candidate) => candidate.cloud);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: LINK_COMMAND_LABEL });
  const linkMachine = useLinkMachine(environmentId);
  const selected =
    choice ??
    (machines.length === 0
      ? ANOTHER_ADDRESS
      : !labs && machines.length === 1
        ? machines[0]!.environmentId
        : null);
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessReadScope);
  // A picked machine that left the list has no address here either.
  const needsAddress = selected !== null && (machine === null || machine.urls.length === 0);
  // This client mints a code there when it is connected with a session that may
  // create pairing links, and only for its own addresses: anything can answer
  // as that machine at one typed in, so that one gets a code the user fetched.
  const canMint =
    targetId !== null &&
    !needsAddress &&
    Option.isSome(connected) &&
    mayMint &&
    !mintFailed.has(targetId);
  const ready =
    selected !== null &&
    (!needsAddress || address.trim().length > 0) &&
    (canMint || pairingCode.trim().length > 0);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(null);
      setAddress("");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
    }
  };
  // A machine this client knows is linked as it, with a code minted there when it can be.
  // A typed address links alone: only this app's own addresses name a machine.
  const linkPicked = async (): Promise<Result.Result<PeerLink, string | null>> => {
    if (machine !== null && !needsAddress) {
      const linked = await linkMachine(machine, access, canMint ? undefined : pairingCode.trim());
      if (Result.isSuccess(linked)) return Result.succeed(linked.success);
      if (linked.failure.minting)
        setMintFailed((failed) => new Set(failed).add(machine.environmentId));
      return Result.fail(linked.failure.message);
    }
    const result = await link({
      environmentId,
      input: { url: address.trim(), pairingCode: pairingCode.trim(), access },
    });
    if (result._tag === "Success") return Result.succeed(result.value);
    return Result.fail(
      isAtomCommandInterrupted(result) ? null : String(squashAtomCommandFailure(result)),
    );
  };
  const submit = async () => {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    const result = await linkPicked();
    inFlight.current = false;
    setBusy(false);
    if (Result.isSuccess(result)) {
      toastManager.add({
        type: "success",
        title: gt("Linked {label}", { label: result.success.label }),
      });
      handleOpenChange(false);
    } else if (result.failure !== null) {
      failureToast(gt("Could not link the environment"), result.failure);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            {gt("Link", { $context: "verb, links an environment" })}
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Link an environment</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Agents here can then launch, message and wait on threads there. It appears under
              Authorized clients in that environment's Sharing & access, where it can be revoked.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={setChoice}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                <T>Already linked. Linking again renews it with the access you pick.</T>
              </p>
            ) : null}
            {needsAddress ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Address</T>
                </span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      This app has no address for <Var>{machine.label}</Var> that another machine
                      can reach. Enter its https or Tailscale address.
                    </T>
                  </span>
                ) : null}
              </label>
            ) : null}
            {needsAddress && address.trim() ? <LinkAddressWarning address={address} /> : null}
            {selected === null || canMint ? null : (
              <label className="block space-y-1.5">
                {/* oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English */}
                <span className="block text-xs font-medium text-foreground">Sign-in code</span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? gt("From Sharing & access there, or t3 pair")
                      : gt("Paste the code")
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      Create a link on <Var>{machine.label}</Var>: Settings → Sharing & access →
                      Authorized clients → Create link, then paste its code here.
                    </T>
                  </span>
                ) : null}
              </label>
            )}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? gt("Linking…") : gt("Link", { $context: "verb, links an environment" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
