# Release Runbook

Unified release workflow: `.github/workflows/release.yml`. Beta is a product label, not a release channel—channels remain `stable` and `nightly` (plus `preview` for maintainer test builds).

## Channels and triggers

- **Stable (`channel=stable` on `main`, or pushing a `vX.Y.Z` tag):** Manual dispatch promotes the **latest published nightly commit** (not `main` HEAD) using its base version unless overridden. Pushing a `vX.Y.Z` tag ships that exact commit. Finalization commits version bumps to `main` using `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`.
- **Nightly (scheduled every 30 min when new commits exist and >=6 h elapsed, or manual `channel=nightly` on `main`):** Publishes a GitHub prerelease, `nightly` desktop updater channel, `nightly` npm dist-tag, hosted `nightly` web alias, and marketing site. Does not bump versions on `main`.
  - Pause/resume automatic nightlies: `gh variable set PAUSE_NIGHTLY -b true -R pingdotgg/t3code` / `gh variable delete PAUSE_NIGHTLY -R pingdotgg/t3code`.
- **Preview (`channel=preview`, any branch—default dispatch channel):** Exercises build, signing, notarization, and smoke tests into a **draft** GitHub release and skips npm, web, AUR, and announcements. **Never publish a preview draft or push a test tag**—there is no dry-run tag path (any non-nightly `v*` tag publishes stable), and published preview tags hide nightlies from the update feed. Rebase onto `main` before dispatching `preview`.
- **PR macOS previews:** Applying the `preview:mac` label triggers a two-workflow split (`desktop-macos-preview.yml` builds the untrusted JS bundle; `desktop-macos-preview-publish.yml` checks author trust against `main`'s `.github/VOUCHED.td`, packages/signs using `main`, and publishes to rolling `desktop-preview`). One-shot per commit; label is removed automatically.

## Critical release invariants

- **Server self-update ordering:** Connected servers update to the exact client version by downloading the GitHub Release CLI archive (or `npx t3@<version>`). Keep the release graph order strictly: `release` (CLI archives + `SHA256SUMS` + desktop installers) → `publish_cli` (`t3` npm launcher) → `deploy_web` (hosted channel alias). Never publish clients before the archives and npm launcher exist. Pair Cloud servers update the same way, but from the repository in their `T3CODE_RELEASE_BASE_URL`, which [Pair Cloud release](#pair-cloud-release) publishes.
- **Standalone CLI archives & Node pin:** `engines.node` in root `package.json` must stay exact (Node SEA builds reject mismatches). There is no macOS x64 CLI archive (SEA is unsupported there; x64 desktop uses Electron).
- **Smoke fixture:** `scripts/fixtures/desktop-launch` is intentionally an old SQLite snapshot to verify forward migrations on packaged builds—never regenerate it on schema changes.
- **Hosted web & marketing:** Vercel Git auto-deployments stay disabled (`apps/{web,marketing}/vercel.ts`). Releases build with `--skip-domain` and alias `app.t3.codes` / `latest.app.t3.codes` (stable) or `nightly.app.t3.codes` + marketing (nightly) only after publication.

## Update feed

Nightly installs check `releases.atom` (the 10 newest git tags), then the `update-feed` release's `nightly.json` pointer, then the GitHub API as fallback. **Never delete the `update-feed` release.**

- If `Check the update feed` fails because stray/preview tags pushed the newest nightly out of `releases.atom`, delete the unneeded tags (`git push origin :refs/tags/<tag>`—converting a release to draft keeps its tag).
- **To pull a bad nightly:** delete its release and tag, run `gh release delete-asset update-feed nightly.json` (so installs fall back until the next tick rewrites it), and move npm's `nightly` dist-tag back with `npm dist-tag add t3@<last-good> nightly`.

## Pair Cloud release

- **Workflow:** `.github/workflows/sandbox-image.yml` ("Pair Cloud release"), separate from `release.yml` because that workflow's jobs only run for `pingdotgg/t3code`. It runs on the same stable tags and publishes to the repository running it, so a fork publishes its own release unchanged.
- **Versions** are `<upstream version>-pair.<n>`, for example `0.1.7-pair.1`. Bump them in a release commit with `node scripts/update-release-package-versions.ts <version>`, so the web, desktop and server packages agree, then push the tag `v<version>` on that commit. The tag must equal `apps/server/package.json`'s `version`: a server pulls that exact image tag, and there is no `latest`.
- **One tag publishes, in order:**
  - `ghcr.io/<owner of the running repo, lowercased>/t3-sandbox:<version>` for amd64 and arm64. A release fails before any build if the image's pinned Claude Code or Codex is not `supported` by the manifest bundled with that version (`check-providers`).
  - A GitHub release `v<version>` with `t3-<version>-linux-x64.tar.gz`, `t3-<version>-linux-arm64.tar.gz`, `SHA256SUMS` and `install.sh`. Each archive is the CLI archive plus a `runner/` tree, the same runner build the image bakes in, which the server serves to its machines. A server built without that tree cannot start cloud machines. The release job waits for the image tag, so no release exists before its image.
- **Install** a release with `T3CODE_VERSION=<version> T3CODE_RELEASE_BASE_URL=https://github.com/<owner>/<repo>/releases/download` in front of `install.sh`, as in [Install Pair Cloud](../user/pair-cloud.md#install-the-release). `t3 update` reads `T3CODE_RELEASE_BASE_URL` from the shell or the service's `service.env`, and lists that repository's releases.
- **Never replaced:** the workflow refuses a version whose image tag or release already exists, so a bad release is fixed with a new version.
- **Dry run:** a fork proves the pipeline with `workflow_dispatch` and a `version` input. It publishes the image as `<version>-dryrun.<run id>` and uploads the four release files as the artifact `pair-cloud-release-<version>-dryrun.<run id>`. It creates no release and no tag.
- **Smoke test:** every archive is tested on its own architecture: `--version`, `serve`, the runner tree's layout, and `apps/server/scripts/runner-release-smoke.ts`, which serves the archive's runner through the real route and hub, downloads it the way a machine's bootstrap does, and runs a command through the attached runner.
- **One-time step:** after the first push, set the `t3-sandbox` package to public in the owner's package settings. A private package makes every pull from a team server fail with an auth error.

## T3 Connect relay deployment

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. See [infra/relay/README.md](../../infra/relay/README.md#deployment-ci) for required variables/secrets. Keep `.env.example` in sync with `production` public identifiers so preview builds work off non-`main` branches. After editing a secret/variable, manually run **Deploy T3 Connect relay** (with `force` unchecked).

Labeling a same-repo PR `relay:preview` deploys stage `pr-<number>` (cleaned up on unlabel/close).

### Managed tunnel cleanup rollout

`RELAY_TUNNEL_CLEANUP_MODE` and `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` accept `off` (default), `dry-run`, or `enabled` and take effect on the next relay deploy (without `force`). Monitor `relay.managed_endpoint_reaper.sweep` spans in Axiom. To stop cleanup during an incident, set the mode to `off` and redeploy the relay.

## Mobile releases

- **iOS TestFlight / App Store:** Merges to `main` publish compatible OTAs and build TestFlight prereleases (`testflight` profile at `3.0.0`). To cut an App Store build, dispatch **Mobile EAS Production** (`mode=build`, `profile=production`, `platform=ios`, explicit version). Before shipping `3.0.0` to the App Store, advance `build.testflight.env.T3CODE_MOBILE_VERSION` in `apps/mobile/eas.json` to the next unreleased major.
- **Android APK mirror:** `.github/workflows/mobile-android-apk.yml` polls Google Play Alpha hourly and mirrors new Play-signed universal APKs to `android-beta-<build-number>` prereleases (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`). Nightlies attach the latest internal-testing APK when available.

## Windows payload topology and update validation

Windows packages the bundled server and its unpacked native modules in `resources/server.asar` (+ `server.asar.unpacked`) and embeds the matching-architecture Linux CLI archive as `resources/wsl-runtime.tar.gz` + SHA-256 sidecar (passed via `--wsl-runtime`). Avoid whole-package smart unpacking (keeps unpacked file counts and NSIS differential blockmaps bounded). `scripts/build-desktop-artifact.ts` enforces all structural, native-load, and WSL archive checks at build time.

## One-time credentials setup

### npm OIDC trusted publishing

Configure `t3` on npm with GitHub Actions Trusted Publishing for `.github/workflows/release.yml` (the workflow publishes only the `t3` launcher tarball via `npm publish --provenance`).

### Apple signing and notarization (macOS)

- **Secrets:** `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (raw `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` (base64 profile for `com.t3tools.t3code` with Associated Domains).
- **Variables:** `APPLE_TEAM_ID`, optional `CLERK_PASSKEY_RP_DOMAINS`.
- The packager only enables passkey entitlements (`keychain-access-groups`, `com.apple.developer.web-browser.public-key-credential`) present in the provisioning profile; regenerate and re-upload `MACOS_PROVISIONING_PROFILE` after Apple approves managed capabilities. Complete Clerk AASA setup per [Connect setup](./02_connect-setup.md#desktop-passkeys).

### Azure Trusted Signing (Windows)

Set secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` with an Entra service principal granted Trusted Signing permissions.

## Ongoing stable release checklist

1. Verify the latest nightly (desktop launch, `npm view t3@<version> version`, remote server update + DB migration smoke test).
2. Dispatch **Release** on `main` with `channel=stable` (leave `version` blank unless overriding the nightly's base version).
3. Confirm `Resolve release commit` matches the verified nightly, then verify `release` → `publish_cli` → `deploy_web` all succeed.
4. Smoke-test the published artifacts.
