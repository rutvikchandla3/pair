import {
  type MemberId,
  type OrchestrationDispatchCommandError,
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type ProjectId,
  repositoryGroupingKeyOf,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import { GitHubAppInstallationTokens } from "../sandbox/credentials/GitHubAppInstallationTokens.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { MemberGitHub } from "../team/MemberGitHub.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { gitConfigEnv } from "../vcs/VcsProcess.ts";
import { makeProjectCloneHooks } from "./ProjectCloneHooks.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";

const HOST = "github.com";
const REQUEST_TIMEOUT = Duration.seconds(15);
const FETCH_TIMEOUT_MS = 120_000;
const GITHUB = SourceControlProviderKind.make("github");
const OPERATION = "add-pair-cloud-project";
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Persisted in each checkout by `git clone -c`, so every later git command there keeps it. */
export const HARDENED_CHECKOUT_CONFIG = {
  "core.hooksPath": "/dev/null",
  "core.fsmonitor": "false",
  "protocol.allow": "never",
  "protocol.https.allow": "always",
  "transfer.fsckObjects": "true",
  "fetch.recurseSubmodules": "false",
  "submodule.recurse": "false",
} as const;

/** No system or global config, so no filter, diff driver or credential helper from the host runs. */
const ISOLATED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export class PairCloudProjectError extends Schema.TaggedError<PairCloudProjectError>()(
  "PairCloudProjectError",
  {
    reason: Schema.Literals([
      "unsupported-remote",
      "already-added",
      "no-access",
      "github-not-connected",
    ]),
    /** `owner/name`. */
    repository: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const repository = this.repository ?? "This repository";
    switch (this.reason) {
      case "unsupported-remote":
        return "Pair Cloud clones only https://github.com repositories.";
      case "already-added":
        return `${repository} is already on Pair Cloud.`;
      case "no-access":
        return `Your GitHub account can't read ${repository}.`;
      case "github-not-connected":
        return "Connect GitHub to clone private repos, in Settings → Team.";
    }
  }
}

/** `owner/name` of a plain `https://github.com/owner/name[.git]` URL, or null for anything else. */
export function parsePairCloudRemote(remoteUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(remoteUrl.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const segments = url.pathname
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(1);
  if (segments.length !== 2) return null;
  const [owner = "", name = ""] = segments;
  const valid = (segment: string) => SEGMENT.test(segment) && segment !== "." && segment !== "..";
  return valid(owner) && valid(name) ? `${owner}/${name}` : null;
}

/** The `owner/name` a clone request names, when it is one Pair Cloud accepts. */
export function requestedRepository(
  input: Pick<ProjectCloneStartInput, "provider" | "repository" | "remoteUrl">,
): string | null {
  if (input.remoteUrl !== undefined) return parsePairCloudRemote(input.remoteUrl);
  if (input.provider === GITHUB && input.repository !== undefined) {
    return parsePairCloudRemote(`https://${HOST}/${input.repository}`);
  }
  return null;
}

const failure = (detail: string, cause?: unknown) =>
  new SourceControlRepositoryError({ provider: GITHUB, operation: OPERATION, detail, cause });

export class PairCloudProjects extends Context.Service<
  PairCloudProjects,
  {
    /** Validates, checks the member's access, picks the checkout path, then starts the tracked clone. */
    readonly add: (
      input: ProjectCloneStartInput,
      options: { readonly memberId: MemberId | null },
    ) => Effect.Effect<
      ProjectCloneStartResult,
      PairCloudProjectError | SourceControlRepositoryError | OrchestrationDispatchCommandError
    >;
    /** Credential env for git on a checkout: App token, else the member's GitHub, else none. */
    readonly gitEnvFor: (input: {
      readonly repository: string;
      readonly memberId: MemberId | null | undefined;
    }) => Effect.Effect<NodeJS.ProcessEnv>;
    /** `git fetch --prune origin` in a Pair Cloud checkout; failures are logged and ignored. */
    readonly fetchCheckout: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly memberId: MemberId | null | undefined;
    }) => Effect.Effect<void>;
  }
>()("t3/project/PairCloudProjects") {}

const make = Effect.gen(function* () {
  const { cloudOnly, checkoutsDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const hostEnv = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const projects = yield* ProjectService.ProjectService;
  const members = yield* MemberGitHub;
  const appTokens = yield* GitHubAppInstallationTokens;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const httpClient = yield* HttpClient.HttpClient;
  const hooks = yield* makeProjectCloneHooks;
  // Two adds of the same repository must not both pass the duplicate check.
  const addLock = yield* Semaphore.make(1);

  const memberToken = (memberId: MemberId | null | undefined) =>
    memberId === null || memberId === undefined
      ? Effect.succeed(null)
      : members
          .credentialFor(memberId)
          .pipe(
            Effect.map((credential) =>
              Option.isSome(credential) && credential.value.host === HOST
                ? credential.value.token
                : null,
            ),
          );

  const gitEnvFor: PairCloudProjects["Service"]["gitEnvFor"] = Effect.fn(
    "PairCloudProjects.gitEnvFor",
  )(function* ({ repository, memberId }) {
    if (!cloudOnly) return {};
    const appToken = yield* appTokens.readTokenFor({ repository: repository.toLowerCase() }).pipe(
      Effect.map((token) => token.token),
      Effect.orElseSucceed(() => null),
    );
    const token = appToken ?? (yield* memberToken(memberId));
    if (token === null) return { ...ISOLATED_GIT_ENV };
    const basic = Base64.encode(`x-access-token:${Redacted.value(token)}`);
    return {
      ...ISOLATED_GIT_ENV,
      // In the environment only: git never writes GIT_CONFIG_* values to the repository.
      ...gitConfigEnv(
        hostEnv,
        `http.https://${HOST}/.extraHeader`,
        `Authorization: Basic ${basic}`,
        platform,
      ),
    };
  });

  const originKeyOf = (repository: string) =>
    sourceControlDefinitions.repositoryKeyFromRemote(`https://${HOST}/${repository}.git`);

  const ensureNotAdded = Effect.fn("PairCloudProjects.ensureNotAdded")(function* (
    repository: string,
  ) {
    const key = originKeyOf(repository);
    const shells = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => failure("Couldn't read this server's projects.", cause)));
    for (const shell of shells) {
      const clone = yield* tracker.get(shell.id);
      const keys = [
        shell.repositoryIdentity ? repositoryGroupingKeyOf(shell.repositoryIdentity) : null,
        // A clone in progress or failed has no identity yet, but holds the repository.
        clone !== null && clone.phase !== "done"
          ? sourceControlDefinitions.repositoryKeyFromRemote(clone.remoteUrl)
          : null,
      ];
      if (keys.includes(key)) {
        return yield* new PairCloudProjectError({ reason: "already-added", repository });
      }
    }
  });

  const checkAccess = Effect.fn("PairCloudProjects.checkAccess")(function* (
    repository: string,
    memberId: MemberId | null,
  ) {
    const token = yield* memberToken(memberId);
    const status = yield* httpClient
      .execute(
        HttpClientRequest.get(`https://api.${HOST}/repos/${repository}`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "user-agent": "t3code",
            ...(token === null ? {} : { authorization: `Bearer ${Redacted.value(token)}` }),
          }),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.map((response) => response.status),
        // Fails closed: no answer from GitHub is never taken as access.
        Effect.mapError((cause) =>
          failure(`Couldn't check access to ${repository} with GitHub. Try again.`, cause),
        ),
      );
    if (status === 200) return;
    if (token !== null && (status === 404 || status === 403)) {
      return yield* new PairCloudProjectError({ reason: "no-access", repository });
    }
    if (token === null && status === 404) {
      return yield* new PairCloudProjectError({ reason: "github-not-connected", repository });
    }
    return yield* failure(`GitHub answered ${status} when checking access to ${repository}.`);
  });

  const add: PairCloudProjects["Service"]["add"] = Effect.fn("PairCloudProjects.add")(function* (
    input,
    { memberId },
  ) {
    const repository = requestedRepository(input);
    if (repository === null) {
      return yield* new PairCloudProjectError({ reason: "unsupported-remote" });
    }
    const destinationPath = ProjectService.pairCloudCheckoutPath(
      path,
      checkoutsDir,
      input.projectId,
    );
    if (destinationPath === null) return yield* failure("Invalid project id.");
    const [owner = "", name = ""] = repository.split("/");
    const url = `https://${HOST}/${repository}`;
    return yield* addLock.withPermits(1)(
      Effect.gen(function* () {
        yield* ensureNotAdded(repository);
        yield* checkAccess(repository, memberId);
        return yield* tracker.start(
          {
            projectId: input.projectId,
            title: input.title,
            createdAt: input.createdAt,
            // No `repository`: the access check stands in for the provider CLI lookup.
            provider: GITHUB,
            remoteUrl: `${url}.git`,
            destinationPath,
            protocol: "https",
          },
          {
            ...hooks,
            cloneOptions: gitEnvFor({ repository, memberId }).pipe(
              Effect.map((env) => ({ config: HARDENED_CHECKOUT_CONFIG, env })),
            ),
            repository: {
              provider: GITHUB,
              nameWithOwner: repository,
              url,
              sshUrl: `git@${HOST}:${owner}/${name}.git`,
            },
          },
        );
      }),
    );
  });

  const fetchCheckout: PairCloudProjects["Service"]["fetchCheckout"] = Effect.fn(
    "PairCloudProjects.fetchCheckout",
  )(
    function* ({ projectId, workspaceRoot, memberId }) {
      if (!cloudOnly) return;
      const checkout = ProjectService.pairCloudCheckoutPath(path, checkoutsDir, projectId);
      if (checkout === null || path.resolve(workspaceRoot) !== checkout) return;
      const origin = yield* git.readRemoteUrl({ cwd: checkout, remoteName: "origin" });
      const repository = origin === null ? null : parsePairCloudRemote(origin);
      if (repository === null) {
        return yield* Effect.logWarning("Pair Cloud checkout has no github.com origin", {
          projectId,
        });
      }
      yield* git.execute({
        operation: "PairCloudProjects.fetchCheckout",
        cwd: checkout,
        args: ["fetch", "--prune", "origin"],
        env: yield* gitEnvFor({ repository, memberId }),
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    },
    Effect.ignoreCause({ log: true }),
  );

  return PairCloudProjects.of({ add, gitEnvFor, fetchCheckout });
});

export const layer = Layer.effect(PairCloudProjects, make);
