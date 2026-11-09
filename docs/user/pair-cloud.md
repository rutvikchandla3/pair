# Install Pair Cloud

Pair Cloud is your team's own Pair server, started in cloud-only mode on an always-on Linux
machine. Every thread on it runs in a [cloud machine](./cloud.md), never on the server, and members
reach it from Pair's desktop, web and mobile apps. This page is for the admin who installs and runs
it.

Below, `<version>` is an exact Pair Cloud version such as `0.1.7-pair.1`, `<releases>` is
`https://github.com/<owner>/<repo>/releases/download` for the repository that publishes your Pair
Cloud releases, and `https://pair.example.com` is your domain.

## What you need

- A Linux x64 or arm64 machine with Docker Engine, `git` and `curl`, that stays on. Run Pair as a
  normal user, not root.
- A domain name with TLS for it, or a Tailscale tailnet.
- A GitHub organization that holds your repositories.
- Outbound HTTPS to github.com, api.github.com and ghcr.io (the machines' base image), and to
  `exp.host` for phone notifications. Machines under gVisor look names up at `1.1.1.1` and
  `8.8.8.8`, so allow outbound DNS (port 53) to them too.

Size the host for the machines you want running at once. Each **Default** machine gets 4 vCPUs and
8 GB of memory, and by default a driver runs one machine at a time per 4 of its host's vCPUs: a
16-vCPU host runs 4. Leave memory for the server too.

## Set up Docker

Plain Docker is not a security boundary: an agent in a machine could reach the host's Docker network
and kernel, and on Pair Cloud that host holds the server's database and secrets. Run the machines
under gVisor:

1. Install gVisor following [gVisor's install guide](https://gvisor.dev/docs/user_guide/install/),
   and register it with Docker under the name `runsc`, letting machines reach Pair's socket:
   `sudo runsc install -- --host-uds=open`, then `sudo systemctl restart docker`.
2. Let Pair's user reach Docker: `sudo usermod -aG docker "$(id -un)"`, then log out and back in.
   Do this before you install the service, which keeps the groups it started with.
3. Check that `docker info` works without `sudo` and lists `runsc` under its runtimes.

Pair starts every machine with `runsc` whenever Docker lists it. Rootless Docker also works: set
`DOCKER_HOST` to its socket in `service.env` below. To keep machines off the server's host entirely,
point the driver at another host's Docker instead (see [Turn on Cloud](./cloud.md#turn-on-cloud)).

## Install the release

On the server, as Pair's user:

```sh
curl -fsSL <releases>/v<version>/install.sh -o install.sh
T3CODE_VERSION=<version> T3CODE_RELEASE_BASE_URL=<releases> sh install.sh
```

The installer downloads the archive for your architecture, checks it against the release's
`SHA256SUMS`, and links `t3` into `~/.local/bin`. Always name an exact version: machines start from
the base image tagged with the server's version, and there is no "latest".

## Configure and start the service

Write `~/.t3/service.env` (see
[Configure the service environment](./background-service.md#configure-the-service-environment)):

```dotenv
T3CODE_CLOUD_ONLY=true
T3CODE_PORT=3773
T3CODE_RELEASE_BASE_URL=<releases>
T3CODE_PUBLIC_URL=https://pair.example.com
```

- `T3CODE_CLOUD_ONLY` makes this Pair Cloud. Agents, terminals and scripts then run only in cloud
  machines. A server without it offers no Cloud.
- `T3CODE_PORT` fixes the port your proxy points at.
- `T3CODE_RELEASE_BASE_URL` is where `t3 update` and **Update server** find new releases.
- `T3CODE_PUBLIC_URL` is the origin people reach the server at, with no path. Webhook tasks use it
  for their full URL.

Then run `chmod 600 ~/.t3/service.env` and `t3 service install`. `t3 service status` shows whether
it runs and where its log is; [Running Pair in the background](./background-service.md) covers the
rest. You don't need `t3 up`: Pair Cloud does not use T3 Connect. After any later change to
`service.env`, run `t3 service restart`.

## Reach it on your own domain

The service answers only on this machine. Put a reverse proxy with TLS in front of it that passes
WebSocket upgrades, the `Host` header and `X-Forwarded-Proto: https`. With Caddy:

```text
pair.example.com {
  reverse_proxy 127.0.0.1:3773
}
```

Or use [Tailscale HTTPS](./remote-access.md#tailscale-https) and set `T3CODE_PUBLIC_URL` to the
tailnet address. GitHub can't reach a tailnet, so webhook tasks from GitHub then need a public
proxy.

Sign yourself in as the server's owner:

```sh
t3 auth pairing create --base-url https://pair.example.com
```

Open the printed link in a browser, or paste it into **Add environment** in the desktop or mobile
app. It works once.

## Turn on Cloud

In **Settings → Cloud**, choose **Add Docker driver**, leave **Docker host** empty, and choose
**Test**. The test starts a machine, checks that it connects back, runs git and reaches github.com,
and removes it. The driver's row under **Overview** then says **gVisor**; on plain Docker it says
**Plain Docker (runc)** and the page warns. [Turn on Cloud](./cloud.md#turn-on-cloud) covers other
Docker hosts, machine sizes, the base image and variables.

## Connect GitHub

Create one GitHub App for your organization, as in
[Set up the GitHub App](./team.md#set-up-the-github-app). Pair Cloud uses it three ways:

- **Members connect their GitHub** through its device flow. Add its Client ID to `service.env` as
  `T3CODE_GITHUB_APP_CLIENT_ID=<client id>` and run `t3 service restart`.
- **Machines clone and push** with one-hour tokens for one repository at a time. Generate a private
  key on the App's GitHub page, then enter the **App ID** and paste the key under **GitHub App for
  cloud threads** in **Settings → Source control → GitHub**.
- **Pull request lists and reviews** fall back to the App's read-only token when the server has no
  GitHub sign-in of its own (see [Pushing and pull requests](./cloud.md#pushing-and-pull-requests)).

Install the App on the repositories your team works in. It needs **Contents** and **Pull requests**
read and write, and **Checks**, **Commit statuses** and **Metadata** read-only.

## Invite the team

In **Settings → Team**, choose **Invite member** and add each person's GitHub username, or run on the
server:

```sh
t3 member invite "Ada Lovelace" --github ada-gh --base-url https://pair.example.com
```

Add `--role admin` for another admin. Each link works once; see [Team](./team.md#invite-people).
The invite dialog tells you what you are trusting a member with: "Members can prompt any thread,
which reaches its provider sign-in and git token. Their agents run in cloud machines, not on this
server." Invite the people you would share those credentials with.

Each member opens their link in a browser, or pastes it into **Add environment** in Pair's desktop
or mobile app (**Add a device** on their row makes links for more devices). Then, on their own row
in **Settings → Team** with Pair Cloud picked under **Showing the team on**, they:

- choose **Connect GitHub**, and
- add a Claude setup token or API key, or a ChatGPT account, under **Your provider accounts**
  (see [Provider accounts](./cloud.md#provider-accounts)). Their Mac's own sign-ins stay on their
  Mac.

On their Mac, they also [link it to Pair Cloud](./outside-agents.md#pair-cloud-from-your-macs-agents),
to move threads there and let their Mac's agents start cloud threads.

Commit messages and pull request text never fall back to a member's own account, and
[review guides](./source-control.md#review-guides) can't use one, so add a team Claude or Codex
account in **Settings → Providers** too. When the model under **Settings → Threads → Text
generation** isn't signed in, Pair Cloud uses a team account that is.

## Add projects

Add each repository once. In the command palette (`Cmd/Ctrl+K`), choose **Add Project**, then
**GitHub repository** or **Git URL**, and enter `<owner>/<name>` or
`https://github.com/<owner>/<name>`. Pair Cloud clones it into its own folder, so there is no
destination to pick. It checks that your GitHub can read the repository, so connect yours first for
a private one. If you connected with **Connect GitHub**, the App must be installed on the repository
too.

Members can also add one from the desktop or web app: on a local project whose `origin` is on
github.com, the workspace menu offers **Add to Pair Cloud**. After that, choosing **Cloud** on their own clone
starts the thread in Pair Cloud's matching project, from a branch they have pushed (see
[Start a cloud thread](./cloud.md#start-a-cloud-thread)).

## Set the team cap and disk retention

In **Settings → Cloud → Compute** on the web or desktop app:

- **Machines at once**, in the driver's **Edit** form, caps how many machines run together. Empty
  means a quarter of the Docker host's vCPUs. More starts wait for a free slot.
- **Delete archived machines' disks** (7 days by default) and **Delete unused machines' disks**
  (30 days) free the disks of machines nobody uses. Their threads stay readable, and waking one
  rebuilds the machine from the server's copy of its work.

## Back up hourly

Everything Pair Cloud keeps is under `~/.t3`. Back it up every hour:

- Snapshot the disk that holds `~/.t3` with your cloud provider's snapshot schedule, or
- run a timer that writes a consistent copy of the database and copies the rest of `userdata`:

  ```sh
  sqlite3 ~/.t3/userdata/statev2.sqlite ".backup /var/backups/pair/statev2.sqlite"
  ```

  plus `~/.t3/userdata/secrets`, `settings.json`, `attachments` and `sandbox/mirrors` (the copy of
  each machine's work), and `~/.t3/service.env`.

Machine disks are Docker volumes and are not part of this backup.

## Restore from a backup

1. Stop the service with `systemctl --user stop t3code.service`.
2. Restore the disk snapshot, or put the copied files back into `~/.t3/userdata`. When you restore
   a `.backup` copy of the database, delete `statev2.sqlite-wal` and `statev2.sqlite-shm` first.
3. Add `T3CODE_RESTORE_MODE=true` to `service.env` and run `t3 service restart`. Then remove the
   line: Pair keeps restore mode on until you leave it.

Machines started after the backup have no record in the restored database. In restore mode Pair
stops them instead of deleting them, deletes no disks, and lists them under **Restore mode** in
**Settings → Cloud**. Once you have checked them, choose **Leave restore mode**; Pair then removes
the listed machines as usual. Pair also turns restore mode on by itself when it finds a machine it
has no record of.

## Upgrade

Every restart interrupts running agents, so drain first, outside working hours:

```sh
t3 drain
t3 update <version> --yes
```

`t3 drain` holds new turns and machine starts, and waits up to 15 minutes (`--timeout`) for running
turns to finish. Members see "Pair Cloud is restarting for an upgrade. New turns start when it's
back." Turns still running at the timeout continue after the restart. `t3 drain --cancel`, or
**Cancel drain** in **Settings → Cloud**, ends a drain without upgrading.

Instead of `t3 update`, an admin can choose **Update server** in Pair's app (see
[Updating Pair](./updating.md#update-a-connected-server)). It installs the app's exact version from
`T3CODE_RELEASE_BASE_URL`, and drains first by itself.

## Offboard a member

1. Run `t3 member remove "<name>"`, or remove them in **Settings → Team**. That signs out all their
   devices, deletes their GitHub connection and pasted token from the server, signs out their
   provider accounts, and ends the link from their Mac.
2. **Discard machine** on their running cloud threads, whose agents may still hold their
   credentials, and **Assign to…** or delete the threads you keep.
3. On GitHub, remove them from the organization, which also ends what the App can do as them.
   Ask them to revoke the App at
   [github.com/settings/apps/authorizations](https://github.com/settings/apps/authorizations),
   delete any GitHub token they pasted, and revoke any Claude setup token or API key they added.
4. If they were an admin, generate a new private key for the App and enter it in **Settings →
   Source control → GitHub**, then delete the old key on GitHub. Rotate any secret they could see in
   **Settings → Cloud → Environment variables** or a provider's environment variables.

## Coming from Conductor Cloud

1. Install Pair Cloud as above, and [invite](./team.md) your team.
2. Have members connect GitHub and add their Claude setup tokens or API keys, or Codex accounts.
3. Paste your Conductor install script into each project's setup script, using `apt-get` where it
   used `dnf` (see [Setup scripts in Cloud](./cloud.md#setup-scripts-in-cloud)).

Conductor transcripts are not imported.
