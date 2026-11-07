// @effect-diagnostics nodeBuiltinImport:off -- a short-lived process git spawns: one socket round trip.
import * as NodeNet from "node:net";

import { ThreadId } from "@t3tools/contracts";
import { RunnerGitCredentialRequest, RunnerGitCredentialResponse } from "@t3tools/contracts/runner";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { GIT_CREDENTIAL_SOCKET } from "./forwards.ts";
import { DEFAULT_STATE_DIR } from "./RunnerConfig.ts";

const INPUT_BYTES = 64 * 1024;
const RESPONSE_BYTES = 64 * 1024;
/** Minting may call the forge's API; git itself has no timeout for a helper. */
const ROUND_TRIP_MS = 60_000;

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

/** Nothing for no credential, so git falls through to its next helper or fails the push. */
export const formatGitCredentialOutput = ({ credential }: RunnerGitCredentialResponse): string =>
  credential === null
    ? ""
    : `username=${credential.username}\npassword=${Redacted.value(credential.password)}\n` +
      `password_expiry_utc=${Math.floor(DateTime.toEpochMillis(credential.expiresAt) / 1000)}\n`;

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

/** `t3 runner git-credential <get|store|erase>`: git's `credential.helper` in a sandbox. */
export const runGitCredentialHelper = async (argv: ReadonlyArray<string>): Promise<void> => {
  const operation = argv[0];
  if (
    argv.length !== 1 ||
    (operation !== "get" && operation !== "store" && operation !== "erase")
  ) {
    process.stderr.write("usage: t3 runner git-credential <get|store|erase>\n");
    process.exitCode = 64;
    return;
  }
  // The server mints every credential, so there is nothing to store or erase.
  if (operation !== "get") return;
  try {
    const threadId = process.env.T3CODE_THREAD_ID?.trim();
    const request = encodeRequest({
      version: 1,
      operation,
      ...parseGitCredentialInput(await readStdin()),
      ...(threadId ? { threadId: ThreadId.make(threadId) } : {}),
    });
    const runnerDir = process.env.PAIR_RUNNER_DIR?.trim() || DEFAULT_STATE_DIR;
    const answer = await roundTrip(`${runnerDir}/${GIT_CREDENTIAL_SOCKET}`, request);
    process.stdout.write(formatGitCredentialOutput(decodeResponse(answer)));
  } catch (error) {
    process.stderr.write(
      `t3 runner git-credential: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
};
