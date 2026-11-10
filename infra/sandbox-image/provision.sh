#!/usr/bin/env bash
# The single definition of the Pair sandbox base. Run as root on stock Ubuntu 24.04: by the
# Dockerfile, and as the first build step of VM-backed images. Reads versions.env, codex.env and
# providers/ beside itself. Every download is checked by SHA-256 or npm integrity.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
. "$here/versions.env"
# shellcheck source=/dev/null
. "$here/codex.env"

export DEBIAN_FRONTEND=noninteractive
arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64) node_arch=x64 ;;
  arm64) node_arch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
suffix="$(printf '%s' "$arch" | tr '[:lower:]' '[:upper:]')"
indirect() { eval "printf '%s' \"\${$1}\""; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# fetch <url> <sha256> <dest>
fetch() {
  curl -fsSL --retry 3 --retry-connrefused -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

# 1. System packages.
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl openssh-client openssh-server sudo tini locales procps less unzip tmux vim \
  git git-lfs ripgrep fd-find jq build-essential pkg-config python3 python3-venv python3-pip \
  iptables xz-utils
# What chrome-headless-shell links against on 24.04 (the t64 names of PreviewBrowserHost's list),
# and fonts, without which pages render no text. Step 11 starts it, so a missing one fails here.
apt-get install -y --no-install-recommends \
  libnss3 libglib2.0-0t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libdbus-1-3 \
  libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 \
  libgbm1 libasound2t64 libexpat1 fontconfig fonts-liberation fonts-noto-color-emoji
rm -rf /var/lib/apt/lists/*
ln -sf /usr/bin/fdfind /usr/local/bin/fd
locale-gen en_US.UTF-8

# 2. Node and gh.
node_dir="node-v${NODE_VERSION}-linux-${node_arch}"
fetch "https://nodejs.org/dist/v${NODE_VERSION}/${node_dir}.tar.xz" \
  "$(indirect "NODE_SHA256_${suffix}")" "$work/node.tar.xz"
tar -xJf "$work/node.tar.xz" -C "$work"
cp -a "$work/$node_dir/bin" "$work/$node_dir/include" "$work/$node_dir/lib" "$work/$node_dir/share" /usr/local/
corepack enable

gh_dir="gh_${GH_VERSION}_linux_${arch}"
fetch "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_dir}.tar.gz" \
  "$(indirect "GH_SHA256_${suffix}")" "$work/gh.tar.gz"
tar -xzf "$work/gh.tar.gz" -C "$work"
install -m 0755 "$work/$gh_dir/bin/gh" /usr/bin/gh
cp -a "$work/$gh_dir/share/man" /usr/local/share/
# The shim, ahead of the real gh on PATH, hands gh the token git would get for origin.
install -m 0755 "$here/gh-shim.sh" /usr/local/bin/gh

# 3. Codex, in the layout CodexInstallation.ts checks.
codex_url="$(indirect "CODEX_URL_${suffix}")"
codex_dir="/opt/codex/${CODEX_VERSION}"
fetch "$codex_url" "$(indirect "CODEX_SHA256_${suffix}")" "$work/codex.tar.gz"
install -d "$codex_dir"
tar -xzf "$work/codex.tar.gz" -C "$codex_dir"
grep -q '"entrypoint": *"bin/codex"' "$codex_dir/codex-package.json"
ln -sf "$codex_dir/bin/codex" /usr/local/bin/codex

# 4. Claude Code, from the lockfile. Its install script puts the native binary in place.
install -d /opt/pair-providers
cp "$here/providers/package.json" "$here/providers/package-lock.json" /opt/pair-providers/
npm ci --omit=dev --prefix /opt/pair-providers
ln -sf /opt/pair-providers/node_modules/.bin/claude /usr/local/bin/claude
rm -rf /root/.npm
claude_version="$(node -p 'require("/opt/pair-providers/node_modules/@anthropic-ai/claude-code/package.json").version')"

# 5. Chrome's headless shell, the build the server's Playwright drives, for the machine browser.
chrome_platform="$([ "$arch" = amd64 ] && echo linux64 || echo linux-arm64)"
chrome_dir="/opt/pair-chrome/${CHROME_VERSION}"
fetch "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${chrome_platform}/chrome-headless-shell-${chrome_platform}.zip" \
  "$(indirect "CHROME_SHA256_${suffix}")" "$work/chrome.zip"
unzip -q "$work/chrome.zip" -d "$work/chrome"
install -d /opt/pair-chrome
mv "$work/chrome/chrome-headless-shell-${chrome_platform}" "$chrome_dir"
ln -sf "$chrome_dir/chrome-headless-shell" /usr/local/bin/pair-chrome

# 6. The agent user. Ubuntu 24.04 ships an `ubuntu` user at uid 1000.
if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi
useradd -m -u 1000 -s /bin/bash t3
echo 't3 ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/t3
chmod 0440 /etc/sudoers.d/t3
visudo -c -q -f /etc/sudoers.d/t3

# 7. User npm prefix, ahead of everything on PATH.
install -d -o t3 -g t3 /home/t3/.npm-global
printf 'prefix=/home/t3/.npm-global\n' >/home/t3/.npmrc
chown t3:t3 /home/t3/.npmrc
echo 'export PATH="/home/t3/.npm-global/bin:$PATH"' >/etc/profile.d/pair.sh

# 8. Git asks the server for every credential through the runner and never stores one; SSH
# remotes on github.com go over HTTPS so the helper answers them too. No user.name: the server
# sets the identity per process.
cat >/etc/gitconfig <<'GITCONFIG'
[credential]
	helper = !t3 runner git-credential
	useHttpPath = true
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
GITCONFIG

# 9. Directories other components fill in.
install -d -m 0700 /etc/pair-runner
install -d -m 0755 /opt/pair-runner /t3-sandbox

# 10. What this image runs, keyed by the model manifest's driver names.
# `browser` is absent from images built before it, so every reader treats it as optional.
printf '{"pairVersion":"%s","providers":{"claudeAgent":"%s","codex":"%s"},"browser":"%s"}\n' \
  "${PAIR_VERSION:-dev}" "$claude_version" "$CODEX_VERSION" "$CHROME_VERSION" >/etc/pair-image.json

# 11. The CLIs and the browser must start as the agent user, and be the versions pinned above.
sudo -u t3 -H claude --version | grep -qF "$claude_version"
sudo -u t3 -H codex --version | grep -qF "$CODEX_VERSION"
sudo -u t3 -H pair-chrome --version | grep -qF "$CHROME_VERSION"
# One real start, so a missing library fails the build. Chrome's own sandbox is off here: a
# container forbids it, and vm/install-vm.sh checks it on a VM.
sudo -u t3 -H pair-chrome --no-sandbox --dump-dom about:blank >/dev/null
rm -rf /tmp/node-compile-cache
