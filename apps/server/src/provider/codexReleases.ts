export interface CodexReleaseAsset {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
}
export const CODEX_RELEASES: Readonly<Record<string, CodexReleaseAsset>> = {
  "darwin-arm64": {
    version: "0.166.0",
    target: "aarch64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz",
    sha256: "55a440cb579f970abe7c79ab181e54b0ea4c419be99f333bbd868eebac9c21f0",
    archiveBytes: 165951869,
  },
  "darwin-x64": {
    version: "0.166.0",
    target: "x86_64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-apple-darwin.tar.gz",
    sha256: "1cb65690230be5982c654ba2655e3a3b594dce9c55b780e78bfdfeff829d7ad9",
    archiveBytes: 180076524,
  },
  "linux-arm64": {
    version: "0.166.0",
    target: "aarch64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
    sha256: "7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6",
    archiveBytes: 187370368,
  },
  "linux-x64": {
    version: "0.166.0",
    target: "x86_64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254",
    archiveBytes: 199694962,
  },
  "win32-arm64": {
    version: "0.166.0",
    target: "aarch64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-pc-windows-msvc.tar.gz",
    sha256: "9383152a72f97bb5dd148493c8214e4fed38d805aa2c3297cb3739f7f130becf",
    archiveBytes: 187024318,
  },
  "win32-x64": {
    version: "0.166.0",
    target: "x86_64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: "d559bb88e74d471265857b93b7f19bc250dae527673b9191b33534478093f6bc",
    archiveBytes: 202589789,
  },
};
