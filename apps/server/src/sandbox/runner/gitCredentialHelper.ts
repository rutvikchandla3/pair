// @effect-diagnostics nodeBuiltinImport:off -- a short-lived process git spawns: one socket round trip.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

import { ThreadId } from "@t3tools/contracts";
import {
  type RunnerGitCredentialAnswer,
  RunnerGitCredentialRequest,
  RunnerGitCredentialResponse,
} from "@t3tools/contracts/runner";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { GIT_CREDENTIAL_SOCKET } from "./forwards.ts";
import { DEFAULT_STATE_DIR } from "./RunnerConfig.ts";

const INPUT_BYTES = 64 * 1024;
const RESPONSE_BYTES = 64 * 1024;
/** Minting may call the forge's API; git itself has no timeout for a helper. */
const ROUND_TRIP_MS = 60_000;
const USAGE = "usage: t3 runner git-credential <get|store|erase> | token [--host <host>]\n";

const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(RunnerGitCredentialRequest)),
);
const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(RunnerGitCredentialResponse)),
);

/** git's `key=value` lines up to the first blank line; keys it repeats or we do not use are dropped. */
export const parseGitCredentialInput = (text: string) => {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") break;
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const path = fields.get("path");
  return {
    protocol: fields.get("protocol") ?? "",
    host: fields.get("host") ?? "",
    ...(path === undefined ? {} : { path }),
  };
};

/**
 * What git reads back. A refusal is `quit=1`, so git neither prompts nor tries another helper,
 * and the reason goes to stderr, where git shows it to the agent.
 */
export const formatGitCredentialAnswer = (
  answer: RunnerGitCredentialAnswer,
): { readonly stdout: string; readonly stderr: string } =>
  answer._tag === "Refused"
    ? { stdout: "quit=1\n", stderr: `${answer.message}\n` }
    : {
        stdout:
          `username=${answer.username}\npassword=${Redacted.value(answer.password)}\n` +
          (answer.expiresAt === null
            ? ""
            : `password_expiry_utc=${Math.floor(DateTime.toEpochMillis(answer.expiresAt) / 1000)}\n`),
        stderr: "",
      };

/** Host and `owner/name.git` of an https, scp-style or ssh remote URL; null for anything else. */
export const parseRemoteRepository = (
  remoteUrl: string,
): { readonly host: string; readonly path: string } | null => {
  const url = remoteUrl.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):\/?(\S+)$/u.exec(url);
  const parsed = scp === null ? URL.parse(url) : null;
  const host =
    scp?.[1] ??
    (parsed !== null && ["https:", "http:", "ssh:"].includes(parsed.protocol)
      ? parsed.hostname
      : null);
  const path = (scp?.[2] ?? parsed?.pathname ?? "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "");
  return host !== null && /^[^/]+\/[^/]+$/u.test(path)
    ? { host: host.toLowerCase(), path: `${path}.git` }
    : null;
};

const readStdin = async (): Promise<string> => {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > INPUT_BYTES) throw new Error("credential input too large");
  }
  return text;
};

const roundTrip = (socketPath: string, line: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(ROUND_TRIP_MS, () => socket.destroy(new Error("timed out")));
    socket.once("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        resolve(buffer.slice(0, end));
        socket.destroy();
      } else if (buffer.length > RESPONSE_BYTES) {
        socket.destroy(new Error("response too large"));
      }
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("the runner closed without an answer")));
  });

const ask = async (input: {
  readonly protocol: string;
  readonly host: string;
  readonly path?: string;
}): Promise<RunnerGitCredentialAnswer> => {
  const threadId = process.env.T3CODE_THREAD_ID?.trim();
  const request = encodeRequest({
    version: 1,
    ...input,
    ...(threadId ? { threadId: ThreadId.make(threadId) } : {}),
  });
  const runnerDir = process.env.PAIR_RUNNER_DIR?.trim() || DEFAULT_STATE_DIR;
  return decodeResponse(await roundTrip(`${runnerDir}/${GIT_CREDENTIAL_SOCKET}`, request)).answer;
};

/** `token`: the `gh` shim's GH_TOKEN, the credential git gets for `origin`. */
const originToken = async (host: string): Promise<string> => {
  const remoteUrl = NodeChildProcess.execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const remote = parseRemoteRepository(remoteUrl);
  if (remote === null || remote.host !== host) {
    throw new Error(`this repository's origin is not on ${host}`);
  }
  const answer = await ask({ protocol: "https", host, path: remote.path });
  if (answer._tag === "Refused") throw new Error(answer.message);
  return Redacted.value(answer.password);
};

/** `t3 runner git-credential …`: git's `credential.helper` in a sandbox, and the `gh` shim's token. */
export const runGitCredentialHelper = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [operation, flag, value] = argv;
  const helper = operation === "get" || operation === "store" || operation === "erase";
  const token =
    operation === "token" && (argv.length === 1 || (argv.length === 3 && flag === "--host"));
  if ((!helper || argv.length !== 1) && !token) {
    process.stderr.write(USAGE);
    process.exitCode = 64;
    return;
  }
  try {
    if (token) {
      process.stdout.write(`${await originToken(value?.toLowerCase() ?? "github.com")}\n`);
      return;
    }
    // The server mints every credential, so there is nothing to store or erase.
    if (operation !== "get") return;
    const output = formatGitCredentialAnswer(await ask(parseGitCredentialInput(await readStdin())));
    process.stdout.write(output.stdout);
    process.stderr.write(output.stderr);
  } catch (error) {
    process.stderr.write(
      `t3 runner git-credential: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
};
