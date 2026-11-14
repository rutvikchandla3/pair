# M8 boat.dev hosted machines: implementation spec

Status: approved plan, revision 4, 2026-11-13. Senior review: approved with changes, all applied.
Maintainer decisions of 2026-11-13 are in [§20](#20-maintainer-decisions-of-2026-11-13). Built on
`feat/boat-hosted-machines` against boat's documented API and an in-process fake. The [§5](#5-phase-0-spike)
spike, the live contract suite and the Settings → Cloud Test ran against boat on 2026-11-14 (results there). Where the docs or the code disagreed with this
plan, the sections below say what was built. Written against `feat/pair` at
`ecce2d5c5`; re-read every symbol before editing. boat facts come from docs.boat.dev, read on
2026-11-13; [§5](#5-phase-0-spike) verifies everything the docs leave open before code is written.
Where this spec says **proposed**, it fills a gap the design docs left open, and a reviewer can
overrule it. [§21](#21-review-log) records the senior review and what changed.

Design inputs: [04 §6–§8](../04-sandbox-lifecycle.md) (driver interface, the hosted-vendor
analysis that already maps boat), [03 §3.2, §6](../03-runner.md) (runner route, tokens),
[05 §3](../05-team-images.md) (images by snapshot), [09](../09-byoc.md) (why hosted machines are
offering C, not BYOC). Code models: `GceComputeDriver.ts` (VM driver shape), `VmBaseImage.ts`
(base image state machine), `GceApi.ts` and `GceApiTesting.ts` (typed client and HTTP fake).

## 1. What it makes true

A cloud-only Pair Cloud server reachable at a public `https://` address runs cloud machines as
boat.dev sandboxes:

- **One machine, one sandbox.** Each machine is a boat sandbox: a full Ubuntu 24.04 VM with root,
  systemd and Docker, billed per second while it runs.
- **Sleep and wake.** Stop snapshots the disk and stops billing; start resumes it.
- **No tunnel.** The runner dials out to the server's public address, so no T3 Connect, Tailscale
  or inbound port on the machine is needed.
- **Images in the team's account.** The base image and team images are boat saved snapshots.
- **Tested.** The driver passes the shared contract suite against an in-process fake of boat's API
  on every CI run, and against a real boat account behind `T3_TEST_BOAT=1`.

## 2. Decisions (proposed)

| #   | Decision                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | New driver kind `boat`, with its own settings struct, factory and API client. No generic "hosted vendor" layer.                                                                                                                                      | One vendor. A second hosted driver can extract what the two share then (yagni).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B2  | `driverRef` is the backend name (`sandboxBackendName`), as on GCE and Docker, not boat's `bx_…` id. The driver resolves name → id with `GET /sandboxes?name=…&label=pair.install=…&state=<all>` and caches it in memory.                             | `TeamImageEffectsLive.destroyMachine` passes `backendName(sandboxId)` when a create never answered (`TeamImageEffectsLive.ts:592`); a name works for every caller.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| B3  | **The enrollment secret never goes in a create or resume body.** The driver delivers it after the sandbox is ready: `PUT /files` to `/tmp/pair-boot/bootstrap.env`, then one command, `sudo /usr/local/bin/pair-boat-boot <generation>`.             | Each outbox attempt mints a new secret (`SandboxEffects.ts:495–520`, `RunnerGrants.ts:124`). A body holding it would change per attempt and break `Idempotency-Key` (`409 idempotency_key_reused`). boat also keeps request config, and `/tmp` is not snapshotted. One path serves create and start.                                                                                                                                                                                                                                                                                                             |
| B4  | Sandboxes are created with `noEnv: true`, `monitoring: false`, `ttlSeconds: null`, `snapshots: true`, and `visibility: "private"` on org accounts.                                                                                                   | `noEnv` keeps the boat account's secrets out and removes the in-sandbox boat API key. `monitoring: false` keeps no command history or output at boat. Our lifecycle owns sleep. Org members can't use our machines.                                                                                                                                                                                                                                                                                                                                                                                              |
| B5  | `pair-runner.service` is **not enabled** on boat images; `pair-boat-boot` starts it. A `~/.boat/pre-stop` hook stops it.                                                                                                                             | A warm resume (same machine, within 10 minutes) does not reboot, so only an explicit start reaches it. The pre-stop hook ends the runner and its agents before boat's last snapshot, so the warm window holds no live runner (decision 10).                                                                                                                                                                                                                                                                                                                                                                      |
| B6  | The base image is a saved snapshot built by `stepVmBaseImage` through a boat `VmBaseImageCloud`. The builder never powers off; "stopped" means "the build finished" (§10.2).                                                                         | Reuses the state machine and its tests. boat has no custom images, only saved snapshots of its own Ubuntu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B7  | The driver's `runnerUrl` setting must be set and `https://`, checked on the config (form, health, create), never on the bootstrap's `serverUrl`. Either listener topology works (§11).                                                               | The secret and token cross the internet. Checking the config keeps the contract suite's local stand-in server usable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| B8  | `sleepOnSettle: false`, `defaultIdleSleepMs: 20 * 60_000`.                                                                                                                                                                                           | boat bills per second, but each wake spends a start: the $20 plan allows 12 a minute, 60 an hour and 200 a day. Sleeping on every settle would hit the day limit for a team of 10.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| B9  | The API key is a settings secret (`SettingsSecretValue` with `withDecodingDefaultKey("")` and `settingsSecret`, as `device.ts:48`), stored in the server's secret store, may name a secret-provider reference, and never reaches clients or members. | The house pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| B10 | The driver runs only on a cloud-only server, as the GCE driver.                                                                                                                                                                                      | A server that is not cloud-only offers no Cloud.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B11 | **On `start` and `stop`, every error except `not-found` is retryable, and fails fast.** Account and config errors get `retryAfterMs: 5_000` and a setup hint. Every hint on these two operations is capped at 60 s.                                  | A non-retryable failure on a record that has a disk becomes `failed` with `retryable: false` (`SandboxEffects.ts:127–153`), and the reconciler then destroys its backend (`SandboxReconciler.ts:110–114`). An empty boat wallet or an expired key must never delete disks. A long hint is wrong too: pending backoff blocks every later effect on the thread (`EffectOutbox.ts:469`), hints are capped at 10 min (`EffectWorker.ts:53`), and the wake deadline is 5 min (`SandboxLifecycleWorker.ts:48`). The effect must fail within about a minute, with `failure.retryable: true` and the setup hint showing. |

## 3. Non-goals

- Webhooks from boat. The reconciler already polls `list` and `status`.
- boat's integrated agents (`boat prompt`), desktop streaming, public URLs, forks.
- A `baseSnapshot` override setting like GCE's `baseImage`. Add it when a kit needs it.
- Region choice. boat runs only in Germany, Finland and France and lets no one pick.
- **Maintainer's call, flagged:** periodic runner token rotation during one boot (03 item 11).
  04 §7 lists it with "a hosted driver would also bring". This spec leaves it out because machines
  sleep after 20 idle minutes and get a fresh token on every wake. See open question 7.

## 4. Prerequisites for an operator

1. A Pair Cloud server, cloud-only, reachable over `https://` by boat machines:
   - either its public address, with the member listener serving `/runner/*`;
   - or a public https hostname proxied to its runner listener (§11).
2. A boat account or organization used only by this Pair Cloud install, on a paid plan. The trial
   refuses `ttlSeconds: null` (`400 trial_auto_stop_required`) and `large`.
3. A boat API key, created with `boat api-key create pair --ttl never --actions …`:
   - **`--ttl never`:** without `--ttl` a key expires after 90 days.
   - **Actions:** `sandbox.create`, `sandbox.read`, `sandbox.stop`, `sandbox.resume`,
     `sandbox.delete`, `exec`, `file.read`, `file.write`, `snapshot.read`, `snapshot.write`,
     `account.read`.
   - **Not the `ci` preset:** it has only `sandbox.delete-own`, so after the key is rotated the new
     key could not delete machines the old one created.

## 5. Phase 0: spike

**Status: run, 2026-11-14,** first on a trial and then on the $20 plan. [Results](#spike-results-2026-11-14) follow
the table; only S11 and S13 did not run. The `T3_TEST_BOAT=1` live contract suite passes all 7 cases.

Setup: a paid account and a throwaway Pair Cloud on a public https address. About three hours,
under $1 of compute. Record each result in this section before §7 starts. A failed row changes the
named section.

| #   | Check                                                                                                                                                                                                                                                                                                                                                                                                                                        | Pass                                                                                                              | If it fails                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `POST /sandboxes` with every B4 field on a personal and an org account                                                                                                                                                                                                                                                                                                                                                                       | 202; `GET` shows the fields; no `~/.config/ascii/boat/config.json` in the sandbox                                 | Drop `visibility` for personal accounts                                                                                                                                                                               |
| S2  | Record: `id -u user`; `getent passwd 1000`; Docker packages; `aa-enabled`; where `node` lives; what boat's agent on port 8911 runs on                                                                                                                                                                                                                                                                                                        | Recorded                                                                                                          | Inputs to §10.3                                                                                                                                                                                                       |
| S3  | Run `provision.sh` then `install-vm.sh` with `PAIR_VM_TARGET=boat` (§10.3) on a `small` sandbox                                                                                                                                                                                                                                                                                                                                              | Both exit 0; `boat exec` still works afterwards; `health` stays `ok`                                              | If our Node in `/usr/local` breaks boat's agent, install ours under `/opt/pair-node` with `/usr/local/bin` links for `node`, `npm` and `npx` only                                                                     |
| S4  | **Pass** (paid plan). A saved snapshot of a running builder is `ready` in 27 s (1.76 GB). `/etc`, `/opt`, `/usr/local` and `/home/t3` (including `.cache`) are kept, and `/tmp/pair-base-build` is not. On a trial, saving answers `403 trial_saved_snapshots_not_allowed` (mapped, with the plan hint).                                                                                                                                     |
| S5  | `PUT /files` to `/tmp/pair-boot/bootstrap.env`; `GET /files?path=/tmp/...`; then `POST /commands` `sudo …` as `user`                                                                                                                                                                                                                                                                                                                         | The file arrives; the read works; sudo needs no password                                                          | Read the result with `cat` through a command instead                                                                                                                                                                  |
| S6  | **Pass.** On a cloud-only dev server reached through a Cloudflare quick tunnel, Settings → Cloud → **Test** passes in 33.3 s: base image 1.4 s, create machine 25.6 s, runner connects 3.2 s, git, sudo and github.com 2.4 s, discard 0.5 s. The driver built the base image itself first (builder to ready saved snapshot in about 95 s). A cloud thread turn was not run: Pair Cloud needs a member's GitHub connected to clone a project. |
| S7  | `~/.boat/pre-stop` running `sudo systemctl stop pair-runner.service`; stop, resume within 10 minutes, `ps`                                                                                                                                                                                                                                                                                                                                   | No `t3 runner` or agent process after the warm resume                                                             | Have `stop` run the same command through `POST /commands` before `POST /stop`                                                                                                                                         |
| S8  | Timings, 5 runs each: create from a saved snapshot to `ready`; resume after 10+ minutes to `ready`; `POST /stop` to `archiving`                                                                                                                                                                                                                                                                                                              | Ready p95 under 40 s; `archiving` within 5 s                                                                      | The driver already returns `unavailable` and is replayed (§9.3); record the numbers for the user guide                                                                                                                |
| S9  | **Pass after a fix.** Snapshot paths keep `/home/user` at the root and every other path under `__system__/` (`__system__/etc/t3/build.json`); `readImageFile` stripped only the `/`, so team-image verification would have failed every build, and now maps the path. Re-run on a saved snapshot: `build.json`, `pair-image.json`, `pair-boat-boot` and `.boat/pre-stop` read back. A missing path is `404 path_not_found`.                  |
| S10 | `GET /sandboxes` with and without `state=`; `?name=<n>&label=pair.install=<id>&label=pair.sandbox=<sbx>`; `DELETE` then `GET`                                                                                                                                                                                                                                                                                                                | Record the default state set (the CLI lists only running ones). Filters combine; a deleted sandbox is 404 at once | The driver always sends the explicit `state` list (§9.1) either way; filter client-side if labels and name don't combine                                                                                              |
| S11 | Ask boat support whether a stopped machine in the 10-minute window is paused or running                                                                                                                                                                                                                                                                                                                                                      | Answer recorded                                                                                                   | No change; S7 covers both                                                                                                                                                                                             |
| S12 | Two sandboxes from one saved snapshot: compare `/etc/machine-id` and SSH host keys                                                                                                                                                                                                                                                                                                                                                           | They differ                                                                                                       | `install-vm.sh` on boat resets machine-id as GCE does                                                                                                                                                                 |
| S13 | Resume a sandbox in `error`; replay a create (same `Idempotency-Key`) whose sandbox was `cancelled`                                                                                                                                                                                                                                                                                                                                          | Resume works from `error`; the replay creates a new sandbox or answers 404                                        | `start` calls `POST /recover` for `error`; a cancelled replay locates nothing and creates with a new key (`name` + `-r<n>`)                                                                                           |
| S14 | Clone a large repository into `/t3-sandbox/…/checkouts`, stop past 10 minutes, resume, and time the first `git status`                                                                                                                                                                                                                                                                                                                       | Under 5 s on a repository like this one                                                                           | boat refreshes git indexes only under `/home/user`, 4 folders deep. Measure `SANDBOX_ROOT` under `/home/user` (a bind mount at boot) as the fix, and bring it to the maintainer                                       |
| S15 | `GET /me` or the key list: does a key expose its expiry?                                                                                                                                                                                                                                                                                                                                                                                     | Recorded                                                                                                          | `health` shows the expiry warning only if it does                                                                                                                                                                     |
| S16 | Stop, resume at once (during `archiving`), deliver a new generation                                                                                                                                                                                                                                                                                                                                                                          | The new generation enrolls; a late pre-stop hook does not kill it                                                 | Before `POST /stop`, `stop` writes the generation it stops to `/tmp/pair-boot/stop-generation`. The hook takes `pair-boat-boot`'s lock, and stops the runner only while `/etc/pair-runner/generation` still equals it |

### Spike results (2026-11-14)

Driven by hand against boat's API with this branch's `infra/sandbox-image`, first on a trial account and then on the $20 plan.
Every sandbox and saved snapshot was deleted afterwards. The live contract suite (`T3_TEST_BOAT=1`, through a Cloudflare
quick tunnel and `T3_TEST_BOAT_LISTEN_PORT`) passes all 7 cases.

| #   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Pass**, trial variant. `ttlSeconds: null` answers `400 trial_auto_stop_required` on a trial (mapped). `visibility: "private"` is accepted on a personal account. `noEnv` works: `holdsCreatorLogins: false`, and `config.json` holds only `api_url` and `channel`; `ASCII_TOKEN` and `BOAT_ID` stay. A replay with the same `Idempotency-Key` returns the same sandbox.                                                                             |
| S2  | `user` is uid 1000. Docker is `docker-ce` 29.7 and `containerd.io` from Docker's repository. AppArmor is on, `apparmor_restrict_unprivileged_userns = 0`. boat's agent on 8911 is a native binary (`/opt/ascii-agent/ascii-agents-server`). boat ships Node 20 in `/usr/bin`, nvm Node 24 for `user`, and **`/usr/local/bin/node` as a symlink into `/home/user/.nvm`**. No DMI product name.                                                         |
| S3  | **Pass after a fix.** `base-build.sh` with `PAIR_VM_TARGET=boat` reports `ok` in about 45 s, and boat's agent stays healthy. `provision.sh`'s `cp -a bin /usr/local/` wrote our Node through boat's symlink: it overwrote boat's nvm Node, and `t3`, which cannot enter `/home/user` (0750), fell back to Node 20. `provision.sh` now removes those `/usr/local/bin` entries first; rebuilt, `t3` runs Node 24.22.2 and boat's nvm Node is untouched. |
| S4  | **Blocked:** a trial answers `403 trial_saved_snapshots_not_allowed` (now mapped, with the plan hint). On a sandbox snapshot, `/etc`, `/opt`, `/usr/local` and `/home/t3` (including `.cache`) are kept; `/tmp/pair-base-build` is not.                                                                                                                                                                                                               |
| S5  | **Pass after a fix.** `PUT /files` to `/tmp` works (the file lands 0644, owned by `user`); `sudo` needs no password. `GET /files` answers a JSON envelope with `content`, refuses `/etc` (`400 invalid_path`), and answers a **missing file with `400 sandbox_direct_failed` "ENOENT…", not 404**. `BoatApi.files.read` now reads that as null.                                                                                                       |
| S6  | Pending a paid plan and a public origin.                                                                                                                                                                                                                                                                                                                                                                                                              |
| S7  | **Pass.** `~/.boat/pre-stop` runs on stop; after a warm resume (same boot), the runner unit is inactive.                                                                                                                                                                                                                                                                                                                                              |
| S8  | **Pass.** Create to `ready` 0.3 s (from a warm pool); `POST /stop` to `archiving` 0.3 s, to `archived` 2.6–7 s; a warm resume 0.3 s. Cold resume: see S14.                                                                                                                                                                                                                                                                                            |
| S9  | **Pass after a fix.** Snapshot paths keep `/home/user` at the root and every other path under `__system__/` (`__system__/etc/t3/build.json`). `readImageFile` stripped only the `/`, so team-image verification would have failed every build; it now maps the path. A missing path is `404 path_not_found`.                                                                                                                                          |
| S10 | **Pass.** The default list already includes archived sandboxes; `name`, repeated `label` and `state` combine. A deleted sandbox drops out at once.                                                                                                                                                                                                                                                                                                    |
| S11 | Not asked. S7 and S16 make the answer moot.                                                                                                                                                                                                                                                                                                                                                                                                           |
| S12 | **Pass.** Two forks of one snapshot get different `/etc/machine-id`, SSH host keys and hostnames, so the boat branch rightly skips the reset.                                                                                                                                                                                                                                                                                                         |
| S13 | Not reproducible on demand (an `error` state, a `cancelled` create).                                                                                                                                                                                                                                                                                                                                                                                  |
| S14 | **Pass.** A cold resume (a new machine) is ready in 3.2 s. On a 7,275-file shallow clone, the first `git status` in `/t3-sandbox` takes 3.9 s while files still restore, then 0.08 s; the same repository under `/home/user`, which boat's index refresh covers, takes 0.8 s. No bind mount: a much larger repository pays proportionally more once per cold wake.                                                                                    |
| S15 | **Pass.** `GET /api-keys` shows `expiresAt`, `neverExpires`, `expiringSoon` and `keyLastFour` per key. No expiry warning is built yet.                                                                                                                                                                                                                                                                                                                |
| S16 | **Failed, then fixed.** A resume during a stop answers 200 and is `ready` in 0.2 s while pre-stop still runs, and the old hook then stopped the new generation's runner. The hook now reads the generation as it starts and, under `pair-boat-boot`'s lock, stops the runner only if the generation is unchanged. Re-run: the race keeps the new runner; a normal stop still ends it.                                                                 |

## 6. How it fits together

```text
create(input)                                start(ref, bootstrap)
  locate(name) ──found──┐                      locate(name) ──missing──> not-found
     │ none             │                          │
  POST /sandboxes       │                       archived/archiving/error ──> POST /resume {}
  Idempotency-Key=name  │                          │
     │                  ▼                          ▼
  poll GET until ready (≤ 40 s) ── not yet ──> fail unavailable, retryable (outbox replays)
     │
  deliver(bootstrap): PUT /files /tmp/pair-boot/bootstrap.env
                      POST /commands "sudo pair-boat-boot <gen>"  (no-op only if this generation enrolled)
     │
  return { driverRef: name }      ── runner dials https://<runnerUrl>/runner/v1/connect

stop(ref): POST /stop and return once boat reads `archiving`. boat then runs ~/.boat/pre-stop
           (stops pair-runner and its agents), stops containers, snapshots, removes the machine.
```

## 7. Contracts and settings

- **`packages/contracts/src/sandbox.ts`.** `ComputeDriverKind` (77) gains `"boat"`, and
  `SANDBOX_VM_DRIVER_KINDS` (81) gains `"boat"`. The latter drives the VM wording in the Test,
  Overview and Settings. Chrome's own sandbox is already on for every kind but Docker
  (`MachineBrowser.chromeArgs` keys on `kind === "docker"`).
- **`packages/contracts/src/settings.ts`,** beside `GceSandboxDriver` (1229):

  ```ts
  const BoatSandboxType = Schema.Literals(["small", "default", "large", "xlarge"]);

  /** Every key past `label` is optional, so the member view decodes (serverSettings.ts 170). */
  export const BoatSandboxDriver = Schema.Struct({
    kind: Schema.Literal("boat"),
    id: ComputeDriverId,
    label: TrimmedNonEmptyString,
    size: Schema.optionalKey(SandboxSize),
    runningCap: Schema.optionalKey(PositiveInt),
    apiKey: SettingsSecretValue.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("")),
      secretSetting,
    ),
    /** B7: https:// only, checked by the form, `health` and `create`, never by this schema. */
    runnerUrl: Schema.optionalKey(TrimmedNonEmptyString),
    /** Sent as `X-Boat-Org`, so machines bill one organization's wallet. */
    organization: Schema.optionalKey(TrimmedNonEmptyString),
    /** Absent: small, default and large map to boat's types of the same names. */
    types: Schema.optionalKey(
      Schema.Struct({
        small: Schema.optionalKey(BoatSandboxType),
        default: Schema.optionalKey(BoatSandboxType),
        large: Schema.optionalKey(BoatSandboxType),
      }),
    ),
  });
  ```

  - `SandboxDriverInstance` (1259) adds it.
  - No `https` pattern on the schema. `sandbox.drivers` is a `ForwardCompatibleArray` (1278), which
    silently drops an entry that fails to decode. A hand-edited `http://` URL would make the driver
    vanish, and its machines would fail as `driver-removed`.
  - The implementer confirms that `memberDriverView`'s object, which has no `apiKey`, still
    type-checks against the decoded type with `withDecodingDefaultKey`. If it does not, the member
    view supplies `apiKey: ""`.

- **`apps/server/src/settingsSecrets.ts` `mapSecretFieldGroups` (152).**
  - Map `settings.sandbox.drivers` entries of kind `boat` with
    `secretSettingsFields(BoatSandboxDriver)`.
  - The secret name is `sandbox-driver-${encode(id)}-${encode(field)}`, plus the server-host suffix,
    as the device hosts do.
  - `memberDriverView` (`serverSettings.ts:170`) needs no change: it is an allowlist.
- **`apps/server/src/server.ts`.** The registry (854–861) adds `boat: BoatComputeDriver.make`, and
  its `Effect.Services<…>` type union adds `typeof BoatComputeDriver.make`, which brings
  `SecretResolver` into its requirements.
- **No change to `RunnerEndpoint`.** `chooseRunnerRoute` returns the configured `runnerUrl` as is
  (87), and B7 makes it required for boat.

## 8. `BoatApi`

New `apps/server/src/sandbox/compute/BoatApi.ts`, shaped as `GceApi.ts`:

- a typed client over `HttpClient`, on the node:http agent, as `GceComputeDriver.ts:1296`;
- base URL `https://boat.dev/api/v1`;
- headers `Authorization: Bearer <key>`, plus `X-Boat-Org` when set;
- schemas decode only the fields the driver reads.

| Method                                       | Endpoint                                                                       | Notes                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sandboxes.create(body, idempotencyKey)`     | `POST /sandboxes`                                                              | Header `Idempotency-Key`                                                                                                               |
| `sandboxes.get(id)`                          | `GET /sandboxes/{id}`                                                          | 404 → `null`; `state: "cancelled"` → `null`                                                                                            |
| `sandboxes.list({ name?, labels, cursor? })` | `GET /sandboxes?state=<all non-terminal>&label=k=v…&name=…&limit=100&cursor=…` | `state` is always `init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived,error`; follows `pageInfo.nextCursor`   |
| `sandboxes.stop(id)`                         | `POST /sandboxes/{id}/stop` `{}`                                               | Never `force`                                                                                                                          |
| `sandboxes.resume(id)`                       | `POST /sandboxes/{id}/resume` `{}`                                             | No `type` (`start` carries no size; a new type forces a cold machine) and no `ttlSeconds` (kept)                                       |
| `sandboxes.delete(id)`                       | `DELETE /sandboxes/{id}`                                                       | Header `X-Ascii-Confirm-Delete: <id>`; 404 → success                                                                                   |
| `files.write(id, path, content)`             | `PUT /sandboxes/{id}/files`                                                    | utf8; ≤ 5 MiB                                                                                                                          |
| `files.read(id, path)`                       | `GET /sandboxes/{id}/files?path=…`                                             | 404, and boat's `400 sandbox_direct_failed` "ENOENT…" for a missing file (S5) → `null`                                                 |
| `commands.run(id, command, timeoutSeconds)`  | `POST /sandboxes/{id}/commands` `{ command, timeoutSeconds }`                  | Synchronous, as boat's `user` (hence `sudo`). Never retried by the client: a 502 may have run, and every command it runs is idempotent |
| `savedSnapshots.get(name)`                   | `GET /saved-snapshots/{name}`                                                  | 404 → `null`                                                                                                                           |
| `savedSnapshots.list(namePrefix)`            | `GET /saved-snapshots?namePrefix=…`                                            | boat documents no pagination here: one call answers every match                                                                        |
| `savedSnapshots.save(sandboxId, name)`       | `POST /saved-snapshots`                                                        | 409 `save_in_progress` → success                                                                                                       |
| `savedSnapshots.delete(name)`                | `DELETE /saved-snapshots/{name}`                                               | No confirm header. 404 → success                                                                                                       |
| `snapshots.readFile(snapshotId, path)`       | `GET /snapshots/{snapshotId}/files?path=…`                                     | 404 and 409 `base_image_file` → `null`                                                                                                 |
| `limits`                                     | `GET /limits`                                                                  | `machineTypes[]` of `{ type, available }`                                                                                              |

`BoatApiError` keeps the endpoint template, the HTTP status, boat's `code`, `requestId` and
`Retry-After`. It never keeps the body or message text, since request bodies hold the bootstrap
(ComputeDriver.ts 28).

`mapBoatError(error, { driverId, operation })` builds the error. The table is for `create`,
`destroy`, `status`, `list` and the image operations. On `start` and `stop`, B11 overrides it:

- every row except `not-found` becomes retryable;
- the rows that are otherwise non-retryable get `retryAfterMs: 5_000` and keep their setup hint;
- every `retryAfterMs` is capped at 60,000. That includes a `rate_limited` for the hour or day
  window, which then fails fast with the plan hint rather than parking the thread's queue.

| boat answers                                                                                                                                                                        | `reason`          | `retryable` | Also                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 404                                                                                                                                                                                 | `not-found`       | false       |                                                                                                                                                                                                                              |
| 409 `snapshot_data_expired`                                                                                                                                                         | `not-found`       | false       | The disk is gone: `sandbox.start` reports missing (`SandboxEffects.ts:544`) and the mirror rebuilds the checkout                                                                                                             |
| 409 `idempotency_key_reused`                                                                                                                                                        | `conflict`        | false       | `create` locates first (§9.3)                                                                                                                                                                                                |
| Any other 409 (`sandbox_stopping`, `sandbox_resuming`, `sandbox_starting`, `boat_starting`, `idempotency_in_progress`, `sandbox_securing`, `resume_failed`, `sandbox_not_ready`, …) | `unavailable`     | true        | `retryAfterMs` from `Retry-After`, else 5,000                                                                                                                                                                                |
| 429 `rate_limited`, `IP_RATE_LIMIT_EXCEEDED`                                                                                                                                        | `rate-limited`    | true        | `retryAfterMs` from `Retry-After`                                                                                                                                                                                            |
| 429 `limit_reached`, `member_limit_reached`                                                                                                                                         | `quota`           | true        | `retryAfterMs: 60_000`; `setupHint`: "boat's plan is running as many sandboxes as it allows. Lower Machines at once, or raise the boat plan."                                                                                |
| 402 `billing_required`, `credit_required`, `team_member_cap_reached`; 429 `trial_compute_limit_reached`                                                                             | `quota`           | false       | `setupHint`: "boat's included time is used and its wallet is empty. Add money to the boat wallet."                                                                                                                           |
| 400 `trial_auto_stop_required`; 403 `trial_machine_class_not_allowed`, `trial_saved_snapshots_not_allowed`, `machine_class_plan_required`                                           | `quota`           | false       | `setupHint`: "This boat account is on its free trial, or its plan lacks this size. Pair needs a paid plan: the trial refuses machines without auto-stop, saved snapshots and large machines, and xlarge needs $100 a month." |
| 403 `api_key_expired`                                                                                                                                                               | `auth`            | false       | `setupHint`: "The boat API key expired. Create one with --ttl never and paste it in Settings → Cloud."                                                                                                                       |
| 401; other 403 `api_key_*`                                                                                                                                                          | `auth`            | false       | `setupHint`: "boat refused the API key, or it lacks an action Pair needs. Create a key with the actions in Pair Cloud's guide and paste it in Settings → Cloud."                                                             |
| 503 `out_of_capacity`, `no_ready_machine`                                                                                                                                           | `capacity`        | true        | `retryAfterMs` from `retryAfterSeconds`                                                                                                                                                                                      |
| Other 400, 413                                                                                                                                                                      | `invalid-request` | false       |                                                                                                                                                                                                                              |
| 5xx, 502 `boat_direct_failed`, a network error                                                                                                                                      | `unavailable`     | true        | `retryAfterMs: 5_000`                                                                                                                                                                                                        |

## 9. `BoatComputeDriver`

New `apps/server/src/sandbox/compute/BoatComputeDriver.ts`:

- `make(config)` is the registry factory.
- `makeWithApi(config, installId, api, server)` is what tests call. `server` is `{ cloudOnly,
  provisionTree, guest? }`. `guest` is a test-only seam, as GCE's `server.guest`: `{ command(generation) }`
  replaces delivery's command, machines boot stock boat with no `from`, and no base image is built
  (§14).
- Off cloud-only, every operation fails `unsupported` with a setup hint, as `unsupportedDriver`
  (`GceComputeDriver.ts:282`).
- `make` hands `BoatApi` the API key as an `Effect` over `requireSettingsSecret`, cached per driver
  instance. A 401 reads it once more before failing, so a rotated secret-provider value takes
  effect without a settings edit.

Shared helpers move out of `GceComputeDriver.ts` into `compute/vmHelpers.ts` with no behavior
change: `vmBootstrapText`, `cloudSafeName` and `teamImageName`. The m5 spec planned this move for
the EC2 driver.

Every operation runs inside `bounded(operation)`: it maps errors (B11 on `start` and `stop`) and
ends at `CALL_DEADLINE` (50 s) with `unavailable`, retryable, `retryAfterMs: 5_000`, as GCE
(`GceComputeDriver.ts:354`).

### 9.1 Names, labels and lookup

- **Labels.** `sandboxTags` unchanged. `pair.install`, `pair.sandbox`, `pair.generation` and
  `pair.driver` fit boat's key pattern `[A-Za-z0-9][A-Za-z0-9._/-]{0,62}` and 256-byte values, so
  no mapping is needed (unlike GCE's `toCloudLabels`).
- **`locate(name)`.** Try the in-memory `Map<name, bx_id>` first: `get`, then confirm the name and
  the install label. Else `list({ name, labels: { "pair.install": installId } })`, with the explicit
  `state` list. Several matches: take the oldest and log the others. They cannot happen inside the
  24 hours an `Idempotency-Key` lasts.
- **Ours.** A sandbox is ours when `labels["pair.install"] === installId`. A foreign one is
  `invalid-request` for stop, destroy and start, and `conflict` for create, as GCE.

### 9.2 Capabilities

```ts
{
  persistentDisk: true,
  memoryOnStop: false,       // B5: pre-stop ends the runner before the warm window
  snapshot: false,
  imageBuild: "snapshot",
  maxSessionMs: null,        // ttlSeconds: null
  diskRetentionDays: 14,     // boat keeps a stopped disk at least 14 days; nothing reads it today
  isolation: "vm",
  egressRules: "none",       // boat has no egress API; in-VM rules can be removed by root
  regions: ["eu"],
  nestedDocker: true,
  sizes,                     // from the mapped types: small 2/4, default 4/8, large 8/16, xlarge 16/32
  defaultRunningCap: 20,
  sleepOnSettle: false,      // B8
  defaultIdleSleepMs: 20 * 60_000,
}
```

### 9.3 `create`

1. **Refuse bad input.** `invalid-request` unless:
   - `input.tags["pair.install"] === installId`;
   - `config.runnerUrl` is set and `https://` (B7), and the API key is set;
   - `vmBootstrapText(input.bootstrap)` is non-null.
2. **Resolve the source.**
   - `{ type: "base" }` is the built base saved snapshot (§10), with the same `Building` and
     `Missing` errors as GCE `bootImage` (`GceComputeDriver.ts:819`).
   - `{ type: "build" }` needs `savedSnapshots.get(imageRef)` to be ready, else `not-found`.
3. **Look first.** `locate(input.name)`.
   - Found, ours, with matching `pair.sandbox` and `pair.generation`: go to step 5, resuming first
     when it is `archived`, `archiving` or `error`.
   - Found otherwise: `conflict`.
4. **Create.** `sandboxes.create` with `Idempotency-Key: input.name` and the body `{ name, type,
   from, labels, ttlSeconds: null, noEnv: true, monitoring: false, snapshots: true, visibility?:
   "private" }`.
   - The body is the same on every replay, since it holds no secret (B3).
   - `idempotency_key_reused` (the base image changed between attempts): `locate` again. Found →
     step 5; else `conflict`.
5. **`awaitReady(id)`.** Poll `get` every second until `ready`, `idle` or `running`, while the
   call's deadline leaves 8 seconds for delivery. Not ready yet: fail `unavailable`, retryable,
   5,000 ms. The outbox replays, and the replay arrives at step 3.
6. **Deliver** (§9.11). Return `{ driverRef: input.name, baseImage }`.

### 9.4 `start(driverRef, bootstrap)`

1. `locate`. If it is missing, has `dataExpiredAt` set, or a resume answers 409
   `snapshot_data_expired`: `not-found`, because the disk is lost.
2. `archived`, `archiving` or `error`: `resume(id)` with an empty body. During `archiving`, boat
   takes the same machine back or answers `409 sandbox_stopping` (retryable). S13 settles whether
   `error` resumes or needs `recover`.
3. `awaitReady`, then deliver, as create steps 5–6. A replay of a generation that already enrolled
   is a no-op inside `pair-boat-boot` (§10.4).

Every failure except `not-found` is retryable (B11).

### 9.5 `stop(driverRef)`

1. `locate`. Missing: `not-found` (`callIgnoringMissing` absorbs it).
2. `archiving` or `archived`: done.
3. Otherwise `sandboxes.stop`, then poll `get` for at most 10 seconds until boat reads `archiving`
   or `archived`. Not yet: `unavailable`, retryable.

The driver does not wait for `archived`. `sandbox.stop` already spends part of its 60-second bound
on `snapshotBeforeSleep` (up to 15 s) and `mirrorSync.flush` (`SandboxEffects.ts:545–556`). boat's
own stop then takes pre-stop (up to 60 s), 30 s per Docker container, and the final snapshot.
`archiving` is not billed.

If boat refuses the stop (it could not save the disk), the sandbox goes back to `running`. The
reconciler finds a running backend under a sleeping record and stops it again. boat retries the
save itself.

### 9.6 `destroy(driverRef)`

1. `locate`. Missing: done. Not ours: `invalid-request`.
2. `sandboxes.delete(id)`. boat drops the sandbox from lists and gets at once, so `status` reads
   `missing` right after (S10).

### 9.7 `status` and `list`

| boat `state`                                     | `BackendSandboxStatus` |
| ------------------------------------------------ | ---------------------- |
| `init`, `provisioning`, `provisioned`, `cloning` | `starting`             |
| `ready`, `idle`, `running`                       | `running`              |
| `archiving`, `archived`                          | `stopped`              |
| `error`                                          | `failed`               |
| `cancelled`, 404                                 | `missing`              |

`archiving` reads `stopped`, to match §9.5: it is past our stop and unbilled, and a start during
it resumes. `list(tags)` requires `pair.install`, filters by every given tag, sends the explicit
`state` list, and keeps only sandboxes with a `pair.sandbox` label, which leaves out the base
builder.

### 9.8 Images: `snapshot`, `deleteImage`, `readImageFile`

- **`snapshot(driverRef, "t3-team-image:<n>")`.** The name is `teamImageName(installId, …).name`
  (`pair-<install8>-team-image-<n>`), which fits boat's `^[a-z0-9][a-z0-9-]{0,62}$`.
  - `savedSnapshots.get`, then:
    - `ready`, and `sourceSandboxId` is this machine: return `{ imageRef: name, sizeBytes }`;
    - ready from another source: `conflict`;
    - `saving`: poll, else `unavailable`;
    - `failed`: delete it and fail `unavailable`, so the replay saves again.
  - Missing: `savedSnapshots.save` from the machine as it is, running or stopped. boat takes a fresh
    capture of a running sandbox, so no stop is needed, and the build program has finished writing
    by then.
  - **Never save over an existing name.** boat replaces the artifact.
- **`deleteImage(imageRef)`.** A name without the `pair-<install8>-` prefix, or one that is not a
  valid saved-snapshot name, is not ours, so it counts as missing and succeeds without a call. The
  contract deletes `pair-contract-missing:<uuid>` and expects success
  (`computeDriverContract.ts:276–282`). Otherwise `savedSnapshots.delete`.
- **`readImageFile(imageRef, path)`.** Read `savedSnapshots.get(imageRef).snapshotId`, then
  `snapshots.readFile(snapshotId, snapshotPath(path))`. boat keeps `/home/user` at a snapshot's root
  and every other path under `__system__/` (S9), so `/etc/t3/build.json` is
  `__system__/etc/t3/build.json`.
  - S9's fallback reads the file from a short-lived sandbox.
  - Never `"whole-disk"`: boat snapshots leave out `/tmp`, `/var/cache`, `~/.cache` (except
    Playwright and Deno), the Docker build cache and untagged images.
- **Team images lose those paths, and the verify can't see it.** The `build.json` check
  (`TeamImageEffectsLive.ts:559`) proves the commit landed, not that every cache did. Downloads
  that tools keep in `~/.cache` (Cypress, Puppeteer, pip) are missing from boat team images and
  again after every cold wake. The user guide's team-image section says so, and S4 settles whether
  `/home/t3/.cache` is dropped too.

### 9.9 `health`

In order, each failure a `ComputeDriverError` with a `setupHint`:

1. No API key: "Paste a boat API key." `auth`.
2. No `runnerUrl`, or not `https://`: "Set the Runner URL to an https:// address boat machines
   reach: this server's public address, or a public hostname for its runner listener."
   `invalid-request`.
3. `limits()` proves the key. If a mapped type is not in `machineTypes`, the trial or plan hint
   from §8. If S15 finds the key's expiry, warn within 14 days of it.
4. The base image state, as GCE: `{ pulling }` while building, `{ missing, hint }` after a failed
   build.

`privateNetworkBlock` is `{ applied: false, reason: "boat machines run in boat's cloud, outside
this server's network." }`. `baseImage.version` comes from `/etc/pair-image.json` in the base
snapshot (`readImageFile`), cached by `snapshotId`, since saved snapshots have no description
field.

### 9.10 Logging

- Info once per create, resume, stop, delete and save, with `driverRef` and boat's `id`, never a
  bootstrap.
- Warn on boat `health: "degraded"` seen in `get`: a firewall rule in the machine blocks boat's
  agent.
- Spans: `BoatComputeDriver.<operation>`. `awaitReady`'s poll uses `Effect.fnUntraced`, since one
  span per second would be noise.

### 9.11 Bootstrap delivery

```text
files.write(id, "/tmp/pair-boot/bootstrap.env", vmBootstrapText(bootstrap))
commands.run(id, `sudo /usr/local/bin/pair-boat-boot ${generation}`, 30)
```

- The command text holds no secret, and `monitoring: false` keeps no history.
- A non-zero exit is `unavailable`, retryable. Its stderr goes to the server log as
  `pair-boat-boot:` lines only, never the file.
- Two calls per boot. Under `server.guest`, the command is the guest's instead (§14).

## 10. Machine image

### 10.1 Names

`vmBaseImageNames(installId, tree.sha256)` is unchanged: image `pair-<install8>-base-<tree12>`,
family `pair-<install8>-base`, builder `pair-<install8>-basebuild-<tree12>`. All fit saved-snapshot
names. The provision tree's hash changes once when the boat scripts land, so GCE rebuilds its base
image once.

### 10.2 The boat `VmBaseImageCloud`

| Method                 | boat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findImage(name)`      | `savedSnapshots.get`: `saving` → `pending`, `ready`, `failed`. `installId` is ours when the name has our `pair-<install8>-` prefix, since saved snapshots carry no labels (§12)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `listImages(family)`   | `savedSnapshots.list`, names starting `${family}-`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `deleteImage(name)`    | `savedSnapshots.delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `launchBuilder(input)` | One `sandboxes.create` with `Idempotency-Key: name`. Body: `type: "small"`; `ttlSeconds: 3600` (a billing backstop past the 30-minute build timeout); `noEnv: true`; `labels: { "pair.install": installId }` with no `pair.sandbox`; `files`: each `input.metadata` key at `/tmp/pair-base-build/metadata/<key>` and `input.startupScript` at `/tmp/pair-base-build/base-build.sh` (create `files` total ≤ 256 KB; the tree is ≤ 200 KB); `setupScript`: `sudo env PAIR_VM_TARGET=boat PAIR_METADATA_DIR=/tmp/pair-base-build/metadata bash /tmp/pair-base-build/base-build.sh >/tmp/pair-base-build/build.log 2>&1` |
| `findBuilder(name)`    | `locate`. `state`: `starting` while boat starts; `stopped` when boat reads `archiving`, `archived` or `error`, when `/tmp/pair-base-build/result` exists, or when `setupStatus` is `done` or `failed`; else `running`. `result`: that file, trimmed, else null                                                                                                                                                                                                                                                                                                                                                       |
| `captureImage(input)`  | `savedSnapshots.save(builderId, input.name)` from the running builder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `deleteBuilder(name)`  | When the last result was not `ok`, log the last 20 `pair-base-build:` lines of `build.log` (as GCE logs its console); then `sandboxes.delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The doc comment on `VmBuilder.state` (`VmBaseImage.ts:40`) becomes "`stopped` once the guest has
powered off, or (boat) has finished its build and writes nothing more". The state machine itself
does not change. Everything under `/tmp` stays out of the saved snapshot, so the provision tree,
result and log never reach machines.

### 10.3 Script changes (`infra/sandbox-image`)

`PAIR_VM_TARGET` (default `gce`) selects the branch. GCE and Docker images build as today.

- **`vm/base-build.sh`.**
  - `report` also writes `/tmp/pair-base-build/result` when `PAIR_VM_TARGET=boat`.
  - `power_off` returns without powering off on boat. Whether boat treats a poweroff as a crash and
    restarts it is unknown, and the driver captures a running builder.
  - The guest-attribute write is already skipped under `PAIR_METADATA_DIR`.
- **`provision.sh` step 2.** Remove `/usr/local/bin` entries for Node's binaries before copying
  Node in: boat links `/usr/local/bin/node` into `/home/user/.nvm`, and `cp -a` would write through
  the link (S3). A no-op on Docker and Google Cloud.
- **`provision.sh` step 6.** Create `t3` with uid 1000 when it is free, else the next free uid.
  boat's `user` may hold 1000 (S2). The runner resolves `t3` by name (`RunnerConfig.ts:47`), and
  Docker and GCE images still get 1000.
- **`pair-bootstrap.sh` `fetch`.** Add `--retry 5 --retry-all-errors --retry-delay 1` to `curl`.
  boat warns that the first outbound connection can fail in the first second after `ready`, and
  the bundle fetch is the first. It is harmless on every driver.
- **`vm/install-vm.sh` on boat:**
  - Skip the Docker install and `daemon.json`. boat ships Docker, and reinstalling `docker.io` over
    `docker-ce` conflicts (S2). Keep `usermod -aG docker t3` and the three `docker … version`
    checks.
  - Install `boat/pair-boat-boot.sh` as `/usr/local/bin/pair-boat-boot`, and a drop-in
    `pair-runner.service.d/boat.conf` that clears `ExecStartPre=`, since `pair-vm-boot` reads GCE
    metadata. Do **not** `systemctl enable pair-runner.service` (B5).
  - Install `/home/user/.boat/pre-stop`, owned by `user`, mode 0755. It reads
    `/etc/pair-runner/generation` as it starts, then under `pair-boat-boot`'s lock stops
    `pair-runner.service` and removes `bootstrap.env` only if the generation is unchanged: a resume
    can land while the hook runs (S16).
  - Skip `cloud-init clean`. Reset `machine-id` only if S12 shows boat does not.
  - Load the Chrome AppArmor profile only when `aa-enabled` says yes. The Chrome sandbox check still
    runs.

### 10.4 `boat/pair-boat-boot.sh <generation>` (new, root via sudo)

```sh
set -eu
exec 9>/run/pair-boat-boot.lock
flock 9
DIR=/etc/pair-runner SRC=/tmp/pair-boot/bootstrap.env
case "${1:-}" in '' | *[!0-9]*) echo "pair-boat-boot: generation is not a number" >&2; exit 1 ;; esac
# Skip only a runner of this generation that already enrolled. One still enrolling is restarted
# with the newest secret; the one it holds stays valid too, so either enrolls.
if [ "$1" = "$(cat "$DIR/generation" 2>/dev/null || true)" ] &&
  systemctl is-active --quiet pair-runner.service && [ -s /run/pair-runner/token ]; then
  rm -f "$SRC"; exit 0
fi
[ -s "$SRC" ] || { echo "pair-boat-boot: no bootstrap" >&2; exit 1; }
install -d -m 0700 "$DIR"
install -m 0600 -o root -g root "$SRC" "$DIR/bootstrap.env"; rm -f "$SRC"
printf '%s\n' "$1" >"$DIR/generation"
systemctl restart --no-block pair-runner.service
```

- `pair-bootstrap` reads and deletes `bootstrap.env` as on GCE.
- `restart` also replaces a runner of an older generation, such as one left after a forced stop.
- A replayed mint leaves the generation's earlier unspent secrets valid until they expire, and the
  first to enroll spends the generation (`RunnerGrants.mint`, table
  `sandbox_runner_superseded_enrollments`). That closes the unenrolled-runner hole for every driver,
  including GCE's `boot` replay, which skips a running instance of the same generation.

## 11. Runner route, TLS and the token

The server's runner path gets nothing new. `runnerUrl` goes into the bootstrap as is
(`RunnerEndpoint.ts:87`). Enrollment, one socket per sandbox, and revocation at stop and destroy
(`SandboxEffects.ts:557`, `:583`) are unchanged.

Two topologies work:

- **No runner listener.** `runnerUrl` is the server's public address. The member listener then
  serves `/runner/*` (`server.ts:1005`, `dialsOverTcp`) to everyone, for every driver's machines.
  The routes are guarded by enrollment secrets and sandbox tokens, not by network. The user guide
  says so.
- **A runner listener** (`T3CODE_RUNNER_HOST`). It accepts only private-network peers
  (`RunnerEndpoint.ts:230`), so a reverse proxy on the same host can front it. `runnerUrl` is a
  public https hostname proxied to it, such as `https://runner.pair.example.com`. The member
  listener keeps refusing runners (`RunnerEndpoint.ts:198`).

Credentials over the public internet:

| Credential        | Where on boat                                                                                                                     | Exposure                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| boat API key      | The server's secret store only                                                                                                    | Never on machines (`noEnv`, and we write none); never sent to clients or members                                          |
| Enrollment secret | `/tmp/pair-boot/bootstrap.env` for under a second, then `/etc/pair-runner/bootstrap.env` (0600) until `pair-bootstrap` deletes it | One use, 15 minutes, this generation only. It passes through boat's files API and lands on boat's disk, outside snapshots |
| Sandbox token     | Runner memory and `/run/pair-runner` (tmpfs)                                                                                      | Revoked at every stop. Pre-stop ends the runner, so the warm window holds none alive                                      |
| TLS               | An `https://` runner URL, required (B7)                                                                                           |                                                                                                                           |

## 12. Security and trust, in short

- **boat is trusted with the VM.** It can read the disk and memory, so it can read checkouts,
  provider credentials while processes run, and git tokens. This is offering C of 09 §1 (hosted
  machines). The user guide says so and names the data location: the EU, with snapshot copies
  possibly outside it.
- **Ownership is by label, and by name for saved snapshots.** Saved snapshots carry no labels, so a
  `pair-<install8>-` name is taken as ours. The guide requires a boat account or organization used
  only by this install.
- **The agent can reach boat as its own sandbox only.** `noEnv` removes the in-sandbox API key.
  `ASCII_TOKEN` stays and can expose a port of its own sandbox on a public URL. That is no more than
  an agent can do through any tunnel, so it is documented, not blocked.
- **No egress rules.** `egressRules: "none"`, as GCE without a VPC firewall.
- **Decision 10.** The pre-stop hook ends the runner's control group before the last snapshot, so
  `memoryOnStop: false` holds as long as S7 passes. Its fallback runs the same stop through
  `commands.run` first.
- **Disks survive account trouble (B11).** An empty wallet, an expired key or a revoked action
  leaves records retryable, so the reconciler never destroys their disks.

## 13. Surfaces

| Surface               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, Settings → Cloud | `DRIVER_KIND_LABELS.boat = "boat.dev"` (`CloudSettings.tsx:76`). A `BoatDriverForm` beside `GceDriverForm`: label, API key (password), organization, runner URL (https), size, machines at once. `boatDriverFormError` and `boatDriverFromForm` in `CloudSettings.logic.ts`; the latter keeps unshown keys such as `types` across an edit, as `unshownGceKeys`. A blank key on edit keeps the saved one; the form offers no secret-provider picker, but keeps a saved reference |
| Desktop               | Wraps web; nothing else                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Mobile                | Read-only driver list ("Manage drivers … on the web"); it decodes the new kind through contracts. Check that a boat row renders                                                                                                                                                                                                                                                                                                                                                 |
| Entry points          | Drivers are added only in Settings → Cloud, as today. No palette or keybinding entry exists for drivers                                                                                                                                                                                                                                                                                                                                                                         |
| Providers             | None: Claude, Codex and the rest run in the machine, as on GCE                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Agents and MCP        | None new. Machines run the same paths as GCE                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reverse states        | Add driver ↔ remove driver (existing); stop ↔ start; save image ↔ delete image                                                                                                                                                                                                                                                                                                                                                                                                  |
| Connection modes      | Either listener topology (§11). T3 Connect hostnames are not offered (03 item 11)                                                                                                                                                                                                                                                                                                                                                                                               |
| Managed policy        | `limits.cloud` has no driver-kind allowlist today; nothing to add                                                                                                                                                                                                                                                                                                                                                                                                               |

## 14. Tests

Following AGENTS.md "Verifying": one layer each, the lowest that fails without the change, with no
sleeps or polling in tests.

- **`BoatApi.test.ts`.** `mapBoatError` as one table, one row per line of §8's table, plus the B11
  override rows for `start` and `stop`.
- **`BoatApiTesting.ts`.** An in-process HTTP fake of the endpoints in §8, modeled on
  `GceApiTesting.ts`.
  - It keeps sandboxes with states, labels, names, idempotency keys and files, and records command
    texts and request bodies.
  - **States auto-advance by default,** with no clock: each `get` moves a sandbox on before it
    answers, so a create or resume reads `ready` on the first `get` and a stop reads `archived`.
    Unit tests can hold a state explicitly, and an `onRequest` hook lets a test move the
    `TestClock` in step with the driver. The contract suite has no hooks into the fake, and `awaitReady` must never sit in
    real one-second polls.
  - **It is seeded with a ready base saved snapshot** named
    `vmBaseImageNames(installId, stubSha).image`, and the driver gets a stub `provisionTree` with
    that hash. §3 offers no base override, and GCE's contract relies on one.
  - **Each sandbox keeps a disk marker,** as `GceApiTesting`'s `boot.disk.marker`, so "keeps the
    disk across stop and start" can assert `marker === "g1"`.
  - `make` resolves the API key into `BoatApi`'s construction, so `makeWithApi` needs no
    `SecretResolver`: the contract's `MakeContractDriver` allows only `Scope`. The refresh on 401
    lives in `BoatApi` too, behind a key `Effect` it caches.
  - **The guest.** When the fake receives the delivery command, it reads the delivered
    `bootstrap.env` and calls `postStandInHello` against its `PAIR_RUNNER_URL`. That is the stand-in
    runner's plain-HTTP hello, so the contract's "delivers this generation's bootstrap" runs with
    the suite's `http://127.0.0.1` server (`computeDriverContract.ts:93–95`). The driver's config
    carries an https `runnerUrl` for B7, and the bootstrap's `serverUrl` is the stand-in's.
- **`BoatComputeDriver.contract.test.ts`.** `computeDriverContract` against the fake, and against
  boat behind `T3_TEST_BOAT=1` (`T3_TEST_BOAT_API_KEY`, `T3_TEST_BOAT_RUNNER_URL`), as
  `GceComputeDriver.contract.test.ts:97`.
  - The live run uses `server.guest`: stock boat with no `from`. Its command posts the stand-in
    hello from the machine to the public `T3_TEST_BOAT_RUNNER_URL`, as GCE's `gce-startup.sh`.
- **`BoatComputeDriver.test.ts`,** for cases the contract does not cover:
  - **No secret in any create or resume body or command text.** The fake's recorded bodies hold no
    enrollment value. This is the security property.
  - A create whose sandbox is not ready by the deadline fails `unavailable`, and the replay finds
    it by name and delivers without a second `POST /sandboxes`.
  - `idempotency_key_reused` → locate → continue.
  - `start` on `archiving` and on `error`; with `snapshot_data_expired` → `not-found`; with 402 or
    `api_key_expired` → retryable, `retryAfterMs` 5,000, hint kept; with an hour-window
    `rate_limited` → `retryAfterMs` capped at 60,000 (B11).
  - `deleteImage` of a foreign or invalid name succeeds with no call.
  - `resume` sends an empty body.
  - `stop` returns at `archiving`, and makes no call on `archived`.
  - `snapshot` never saves over an existing name, and deletes and retries a `failed` one.
  - `readImageFile` maps 404 and `base_image_file` to null.
  - `list` always sends the explicit `state` list and drops sandboxes without `pair.sandbox`.
  - `health` hint order: no key, then an http runner URL.
  - The boat adapter's `findBuilder` state mapping, as one table. `VmBaseImage` itself needs no new
    tests.
- **Settings.**
  - `settingsSecrets` tests: one row for a boat driver's `apiKey` (stored, redacted for clients,
    echoed reference kept).
  - `settings.test.ts`: one decode row, a member-view decode row, and an http `runnerUrl` that
    decodes and is kept (§7: the schema must not drop it). The form, `health` and `create` refuse it.
- **`CloudSettings.logic.test.ts`.** Rows for `boatDriverFormError` (http refused, empty key on add)
  and `boatDriverFromForm` (unshown `types` kept).
- **Scripts.** The existing `SandboxProvisionTree` test keeps the tree under 200 KB. `pair-boat-boot`
  is exercised by the live run and the integrated pass; no shell unit test.

## 15. Verify

1. `vp run check:changed`.
2. The live contract suite:
   `T3_TEST_BOAT=1 vp test run apps/server/src/sandbox/compute/BoatComputeDriver.contract.test.ts`.
3. An integrated pass on the spike's Pair Cloud (`test-t3-app` for web):
   1. Add the driver. The base image builds (about 10 minutes), then **Test** passes every step.
   2. Start a cloud thread and run one Haiku turn.
   3. Wait for idle sleep. boat shows the sandbox stopped, with no `t3 runner` alive.
   4. Send again: it wakes with a new generation and answers.
   5. Empty-wallet drill: revoke the key's `sandbox.resume`, send, and see the setup hint. Restore
      the key; the next send wakes the same disk.
   6. Build a team image, activate it, and start a thread on it.
   7. Delete the thread's machine and remove the driver. The boat dashboard shows no leftover
      sandboxes, and only the kept saved snapshots.
4. A runtime transcript of steps 3.2–3.5 from the server log goes in the PR.

## 16. Docs

- **`docs/user/pair-cloud.md`.** A section "Run machines on boat.dev":
  - §4's prerequisites, and the key's actions and `--ttl never`;
  - **Add driver → boat.dev**, and the runner URL for each topology in §11, including that the
    member listener then serves machines;
  - costs, the EU data location, and the 14-day stopped-disk limit;
  - that team images drop `~/.cache` and the Docker build cache, and that containers the recipe
    leaves running start in every machine made from the image;
  - what boat can see.
- **`docs/user/cloud.md` "Turn on Cloud".** One line linking that section.
- **Design docs.** `04-sandbox-lifecycle.md` §7 "boat.dev" is rewritten as built, pointing to the
  code; §8's pick is the maintainer's call (open question 1). In `03-runner.md` §3.2, the table row
  "A hosted vendor (Later)" becomes: boat dials a required https `runnerUrl`.

## 17. PR plan

One PR against `feat/pair`, `feat(cloud): run cloud machines on boat.dev`, with commits in this
order:

1. docs: this plan as M8, and the design-doc updates of §20.1 and §20.4;
2. fix(server): the Google Cloud driver's holes (§20.7), test first;
3. feat(server): the 14-day asleep-disk default (§20.5), with its user docs;
4. refactor(server): the helpers move;
5. feat(infra): scripts (§10.3, §10.4);
6. feat(contracts): contracts and settings;
7. feat(server): `BoatApi` and its fake;
8. feat(server): the driver;
9. feat(web): the web form;
10. docs: user docs (§16).

The commit list above is indicative. Commits 4–9 can merge or split where that reads better, but
2 and 3 stay separate.

## 18. Cost and limits

- **Rates.** `small` $0.018, `default` $0.036, `large` $0.072 and `xlarge` $0.20 an hour, billed
  per second, nothing while stopped. No egress billing.
- **Saved snapshots.** 10 per $20 of plan are included, then $0.056 a day each. Base images (the
  current one plus one kept) and `keepSucceeded` team images count against them.
- **Start limits.** The $20 plan allows 100 at once, and starts at 12 a minute, 60 an hour and 200 a
  day.
  - The admission bucket (10 a minute, `SandboxAdmission.ts`) stays under the minute limit.
  - The hour and day limits answer `429 rate_limited` with a `Retry-After`. On a wake the driver
    caps it at 60 s (B11). The wake then fails retryable with the plan hint, and the member's next
    send tries again. Teams that hit it need a bigger plan; the user guide says so.
- **Server-side egress.** Two kinds of traffic leave the Pair Cloud server's cloud, billed by that
  cloud, not boat:
  - the runner bundle, about 9 MB per new build per machine, kept in `/opt/pair-runner` across
    sleeps;
  - mirror traffic.

## 19. Risks

| Risk                                                                                                        | Mitigation                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| boat changes its base OS under our saved-snapshot diff                                                      | The base image name carries the tree hash, and Refresh rebuilds. A nightly `T3_TEST_BOAT` job catches drift            |
| boat's API or behavior changes (a young vendor, already renamed once from Box)                              | The typed client in one file, the contract suite, the live job                                                         |
| Our Node in `/usr/local` collides with boat's tools                                                         | S3, with the `/opt/pair-node` fallback                                                                                 |
| boat stops a machine out of band (empty wallet, plan limit, crash restart)                                  | The reconciler reads `stopped` or `missing`, as for any driver; a lost runner takes the existing path; B11 keeps disks |
| The first `git status` after a cold wake rereads every file (`/t3-sandbox` is outside boat's index refresh) | S14 measures it, with the `/home/user` bind-mount fallback                                                             |
| EU round trips for US teams (about 100–200 ms)                                                              | Recorded in S6 and documented                                                                                          |

## 20. Maintainer decisions of 2026-11-13

1. **boat is the first hosted vendor.** This replaces 04 §8's "Pick, if one is added: Vercel
   Sandbox". 04 §7–§8, 09's tiers table and offerings (C. Hosted machines), and 10's plan are
   updated to say so, and this milestone is **M8**.
2. **Sizes map one to one** (no `types` override by default). boat `default` is 4 vCPU and 8 GB.
3. **One PR against `feat/pair`**, with separate commits (§17).
4. **This plan is committed** as `docs/product/cloud/implementation/m8-boat.md`, a milestone of its
   own, not inside m5-byoc.md. 10-delivery-plan.md gains an M8 section, and progress.md an M8 entry.
5. **boat may delete stopped disks after 14 days, and Pair's own default follows:** the default
   `asleepAfterDays` drops from 30 to 14 for every driver. The user docs that say 30 days change.
   No Settings warning.
6. **No periodic token rotation in M8** (03 item 11 stays Later).
7. **The Google Cloud driver's holes are fixed in the same PR, in their own commit:**
   - B11 applied to GCE `start` and `stop`: every error except `not-found` is retryable, account
     and config errors fail fast with their hint, and every hint is capped at 60 s;
   - the replay that strands an unenrolled runner (`GceComputeDriver.ts:970`, `RunnerGrants.ts:124`).
     Each fix starts from a failing test (§14).
   - As built: B11 is `wakeFailure` in `ComputeDriver.ts`, applied by both VM drivers' `bounded`.
     The replay is closed in `RunnerGrants`, not in the guest: a replayed mint keeps the earlier
     unspent secrets valid until they expire (§10.4), so it holds for every driver.
8. The size question (former open question 3) is closed by 2. The listener question (former open
   question 2) was closed in revision 2.

## 21. Review log

**Round 1** (senior review, 2026-11-13): **request changes**. All 11 findings were checked against
the code and docs and accepted.

| #   | Finding                                                                                                                  | Resolution                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker: non-retryable account errors on start or stop let the reconciler destroy disks (`SandboxReconciler.ts:110–114`) | B11; §8 override; a test row; drill 3.5 in §15; open question 8 for GCE                                                                                                                                  |
| 2   | Blocker: `GET /sandboxes` may omit stopped sandboxes by default                                                          | An explicit `state` list on every list and locate; S10                                                                                                                                                   |
| 3   | API keys expire after 90 days by default                                                                                 | `--ttl never` in §4; an `api_key_expired` hint; S15                                                                                                                                                      |
| 4   | A replay after delivery strands an unenrolled runner                                                                     | §10.4 skips only an enrolled runner (token present); `flock`                                                                                                                                             |
| 5   | Resume must not send `type`                                                                                              | `resume {}`                                                                                                                                                                                              |
| 6   | The contract suite can't pass with an https check on `serverUrl`; the live run has no guest                              | B7 checks the config; the fake's guest posts the stand-in hello; a `server.guest` seam                                                                                                                   |
| 7   | The stop budget doesn't fit the 60 s bound                                                                               | Return at `archiving`, which reads `stopped`; `snapshot` saves without stopping                                                                                                                          |
| 8   | Team images lose `~/.cache` and similar; S9's fallback contradicted `ComputeDriver.ts:203`                               | §9.8 caveat and docs; S4 covers `/home/t3/.cache`; S9's fallback reads the file from a sandbox                                                                                                           |
| 9   | First-connection flake, machine-id, resume from `error`, cancelled replay, git index                                     | A `curl` retry in `pair-bootstrap.sh`; S12–S14                                                                                                                                                           |
| 10  | The `--runner-host` refusal is over-built                                                                                | Dropped, with `requiresUrl`; §11 documents both topologies                                                                                                                                               |
| 11  | Inaccuracies                                                                                                             | Fixed: outbox wording, `chromeArgs`, saved-snapshot delete header, `diskRetentionDays`, the `server.ts` union, `credit_required`, `withDecodingDefaultKey`, token rotation flagged, member-listener note |

**Round 2** (same reviewer, revision 2): **approve with changes**. Round 1's findings were confirmed
closed: #4 because `RuntimeDirectory` removes `/run/pair-runner` when the unit stops and the
runner writes `token` by rename (`RunnerSocketServer.ts:91–94`); #1 for disks. Six new findings
were verified in code and applied in revision 3:

| #   | Finding                                                                                                                                                    | Resolution                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Major: B11's 15-minute delay parks the thread's queue (`EffectOutbox.ts:469`, cap `EffectWorker.ts:53`) and hides the hint past the 5-minute wake deadline | 5 s for account and config errors; every hint on start and stop capped at 60 s                         |
| 2   | Major: `deleteImage` of a foreign or invalid name must succeed (`computeDriverContract.ts:276–282`)                                                        | Treated as missing, with no call                                                                       |
| 3   | Minor: the fake can't run the contract as described                                                                                                        | Auto-advancing states; a seeded base snapshot and stub tree; a disk marker; the key resolved in `make` |
| 4   | Minor: an https pattern on the schema drops the driver (`ForwardCompatibleArray`)                                                                          | Checked in the form, `health` and `create` only                                                        |
| 5   | Minor: resume during `archiving` can race a late pre-stop hook                                                                                             | S16, with a generation-guarded hook as the fallback                                                    |
| 6   | Minor: S9's probe sandbox can leak                                                                                                                         | `ttlSeconds: 600` and an `Idempotency-Key`                                                             |
