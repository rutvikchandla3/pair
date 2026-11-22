# M9 Agent37 hosted machines

Status: built 2026-11-22 as one PR against `feat/pair`. The driver is built against Agent37's docs
(read 2026-11-22 at [agent37.com/docs](https://www.agent37.com/docs/llms.txt)), passes the shared
contract suite against an in-process fake, and passed the live checks in [§4](#4-spike-2026-11-22)
against a real workspace on its free credit. Code:
[Agent37ComputeDriver.ts](../../../../apps/server/src/sandbox/compute/Agent37ComputeDriver.ts),
[Agent37Api.ts](../../../../apps/server/src/sandbox/compute/Agent37Api.ts).

## 1. What it makes true

A cloud-only Pair Cloud server reachable at a public `https://` address runs cloud machines as
Agent37 instances, a second hosted vendor beside boat.dev (offering C in [09](../09-byoc.md)):

- **One machine, one instance.** Each machine is an instance of Pair's own sandbox image, in a
  gVisor container by default or a microVM (`instanceType: "vm"`), billed per minute while it
  runs and disk-only while stopped.
- **No image build.** Agent37 imports the published `ghcr.io/rutvikchandla3/t3-sandbox:<version>`
  as a workspace template, so there is no builder machine.
- **No tunnel.** The runner dials out to the server's public address.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | New kind `agent37` with its own settings, client and fake, as boat's B1. No shared "hosted vendor" layer.                                                                                                                                | The two APIs share little: Agent37 has no idempotency key, no labels filter, no saved snapshots and no files API outside agent templates.                                                                                           |
| A2  | The base is a workspace template made from the published sandbox image, named `pair-<install8>-base-<sha256(image, entrypoint)[:12]>`. Its `entrypoint` replaces the image's with a loop that waits for a bootstrap.                     | The image's own entrypoint exits without a bootstrap at boot. Registration copies the image in 20–30 s; it runs in its own fiber, and readers hear it is under way after 5 s. Older base templates of the install are then deleted. |
| A3  | `driverRef` is the backend name. Agent37 lists the whole workspace with no filter and allows duplicate names, so the driver matches `name` and the `pair.install` metadata, the oldest instance wins, and `create` deletes later copies. | There is no `Idempotency-Key`: a create the deadline cuts short may still land, and its replay must find it.                                                                                                                        |
| A4  | The bootstrap goes in one root `exec` after the instance runs, base64 inside the command, which writes `/etc/pair-runner/bootstrap.env` for the loop. It skips a runner of the same generation that enrolled.                            | `env` is stored and replayed on every restart, and a create body would carry a per-attempt secret. Exec is the one way in for a custom image.                                                                                       |
| A5  | `mount_path` is `/t3-sandbox`, the billed disk; sizes take each shape's largest disk on the default type (12, 20, 40 GB).                                                                                                                | Everything outside it shares a separate 10 GB layer. A fork keeps the source's mount path, so a per-sandbox path would break machines made from a team image.                                                                       |
| A6  | A team image is a stopped fork of the build machine. `readImageFile` answers `whole-disk`. A machine from it forks that instance again, with at least its disk.                                                                          | Agent37 has no snapshot images; a fork copies the whole disk ([§4](#4-spike-2026-11-22) S5).                                                                                                                                        |
| A7  | `stop`, never `sleep`, and `auto_sleep: false`. Pair's lifecycle owns sleep.                                                                                                                                                             | Sleep keeps memory, so a woken runner would hold its old token (decision 10).                                                                                                                                                       |
| A8  | On `start` and `stop`, every error but `not-found` is retryable (`wakeFailure`), as boat's B11.                                                                                                                                          | An empty wallet or a memory limit must never let the reconciler delete a disk.                                                                                                                                                      |
| A9  | `defaultRunningCap: 5`; `nestedDocker: false`; `privateNetworkBlock: applied`; `diskRetentionDays: null`.                                                                                                                                | A topped-up workspace runs 40 GB at once. The image starts no Docker daemon. Agent37 blocks private ranges itself. Stopped disks are kept until deleted.                                                                            |

## 3. Non-goals

- Fork to a new machine (`canCopyMachine`). The fork path would serve it; it waits for a live run.
- Docker inside machines, desktop streaming, public ports, webhooks (the reconciler polls).
- Agent37's network allowlists and its managed LLM, search and Composio services.

## 4. Spike (2026-11-22)

Run on a free-credit workspace (tier 0, 32 GB limit) with release `0.1.7-pair.37`. Everything was
deleted afterwards; the whole run cost under $0.01.

| #   | Check                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Pass.** `POST /templates` from the public GHCR image with the driver's entrypoint: 201 in 21 s with `image_digest` set. The free credit is enough to import from an outside registry.                                                                                                                                                                                                |
| S2  | **Pass.** `POST /instances` (2 vCPU / 4 GB / 12 GB, `mount_path` `/t3-sandbox`, dotted metadata keys, a 41-character name): 201 `running` in 15–22 s; metadata, name and mount path come back as sent.                                                                                                                                                                                 |
| S3  | **Pass.** A root exec answers in about 0.5 s. PID 1 is `tini` running the wait loop; Agent37's own `agent37-init` and sshd run beside it. `/` is a 10 GB 9p layer and `/t3-sandbox` the 12 GB disk; gVisor kernel 4.19; resolvers 1.1.1.1 and 8.8.8.8; github.com reachable. **An exec's command line shows in `ps` inside the machine** while it runs.                                |
| S4  | **Pass.** `stop` answers `stopped` in 0.5 s and `start` `running` in 0.7 s. Files in `/root`, `/etc`, `/home/t3` and `/t3-sandbox` survive; the loop clears the last boot's generation and token.                                                                                                                                                                                      |
| S5  | **Pass.** A fork of a stopped machine is `running` in 22 s with every file of both layers, its mount path and template. A fork with a bigger shape works; one with a smaller disk is `400` "Disk cannot shrink".                                                                                                                                                                       |
| S6  | **Pass.** Two instances may share a name. A deleted instance is 404 at once and leaves the list; a second delete is 404. Exec on a stopped instance is `400 invalid_request`.                                                                                                                                                                                                          |
| S7  | **Pass.** The `T3_TEST_AGENT37=1` live contract suite passes all 7 cases through a Cloudflare quick tunnel.                                                                                                                                                                                                                                                                            |
| S8  | **Pass.** On a cloud-only dev server with a runner listener behind a quick tunnel, Settings → Cloud imports the base template in 29 s, then **Test** passes in 12.1 s: base image 0.3 s, create machine 6.7 s, runner connects 2.6 s, git, sudo and github.com 1.6 s, discard 0.8 s. Re-run on the final code after deleting the template: imported in 13 s, **Test** passed in 9.0 s. |

Not run: a cloud thread turn (it needs a member's GitHub to clone a project), a team image build,
the `vm` type outside the US (the free tier may refuse it), and an instance in `failed`.

## 5. Open

- The secret is in the exec command for its few milliseconds; nothing else runs on the machine
  before its runner enrolls. A file upload path would remove it, if Agent37 adds one for custom
  images.
- Agent37 backs up `/t3-sandbox` nightly, keeps a week, and keeps a deleted instance's backups 7
  more days. Turning that off takes an email to their support.
