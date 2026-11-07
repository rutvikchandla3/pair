import {
  CommandId,
  type MemberId,
  type ProjectId,
  type SandboxGitCredentialSource,
  type SandboxId,
  type ThreadId,
} from "@t3tools/contracts";
import type { RunnerGitCredentialAnswer } from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { MemberGitHub } from "../../team/MemberGitHub.ts";
import { GitHubAppInstallationTokens } from "./GitHubAppInstallationTokens.ts";

/** M1 answers for github.com only: the App, member sign-in and pasted tokens are all github.com. */
const HOST = "github.com";
const REQUEST_TIMEOUT = Duration.seconds(15);
/** Under the helper's own 60 s bound, so git always reads an answer. */
const ANSWER_TIMEOUT = Duration.seconds(45);
const REPOSITORY_PATH = /^[\w.-]+\/[\w.-]+$/u;

interface PickedCredential {
  readonly source: SandboxGitCredentialSource;
  readonly password: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc | null;
  readonly permissions?: Readonly<Record<string, string>>;
}

class ForkCheckError extends Schema.TaggedError<ForkCheckError>()("ForkCheckError", {
  status: Schema.Number,
}) {
  override get message(): string {
    return `GitHub answered ${this.status} to a fork check.`;
  }
}

const RepositoryResponse = Schema.Struct({
  parent: Schema.optional(Schema.Struct({ full_name: Schema.String })),
});

const refused = (
  code: Extract<RunnerGitCredentialAnswer, { _tag: "Refused" }>["code"],
  message: string,
): RunnerGitCredentialAnswer => ({ _tag: "Refused", code, message });

const MISSING = refused(
  "github-credential-missing",
  "Connect GitHub to push: Settings → Team, your row.",
);
const NOT_THIS_THREAD = refused(
  "not-this-repository",
  "This process's thread does not run on this cloud machine.",
);
const UNAVAILABLE = refused(
  "unavailable",
  "Could not get a GitHub credential right now. Try again.",
);

interface AnswerContext {
  readonly sandboxId: SandboxId;
  readonly generation: number;
  readonly threadId: ThreadId;
  readonly repository: string;
}

/** `owner/name` from git's `path` (`owner/name.git`), lower case; null for anything else. */
const repositoryFromPath = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const repository = path
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
  return REPOSITORY_PATH.test(repository) &&
    repository.split("/").every((segment) => segment !== "." && segment !== "..")
    ? repository
    : null;
};

/**
 * Answers git in a sandbox with the narrowest credential the server can mint: the App's
 * one-repository token, else the thread owner's own GitHub, else a refusal git shows the agent.
 * `sandboxId` comes from the runner socket the request arrived on, never from the request.
 */
export class GitCredentialService extends Context.Service<
  GitCredentialService,
  {
    readonly answer: (input: {
      readonly sandboxId: SandboxId;
      /** The helper's `T3CODE_THREAD_ID`; trusted only when that thread uses this sandbox. */
      readonly threadId: ThreadId | undefined;
      readonly protocol: string;
      readonly host: string;
      readonly path: string | undefined;
    }) => Effect.Effect<RunnerGitCredentialAnswer>;
  }
>()("t3/sandbox/credentials/GitCredentialService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const app = yield* GitHubAppInstallationTokens;
  const members = yield* MemberGitHub;
  const orchestrator = yield* OrchestratorV2;
  const httpClient = yield* HttpClient.HttpClient;
  const verifiedForks = yield* Ref.make<ReadonlySet<string>>(new Set());

  /** The project's github.com repository, `owner/name` in lower case. */
  const projectRepository = Effect.fn("GitCredentialService.projectRepository")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) return null;
    const identity = yield* identities.resolve(project.value.workspaceRoot);
    const key = identity?.canonicalKey.toLowerCase() ?? "";
    return key.startsWith(`${HOST}/`) ? repositoryFromPath(key.slice(HOST.length)) : null;
  });

  const pick = Effect.fn("GitCredentialService.pick")(function* (
    sandboxId: SandboxId,
    ownerId: MemberId | null,
    repository: string,
  ) {
    if (yield* app.configured) {
      const minted = yield* app.tokenFor({ sandboxId, repository }).pipe(Effect.result);
      if (minted._tag === "Success") {
        return Option.some<PickedCredential>({
          source: "app-installation",
          password: minted.success.token,
          expiresAt: minted.success.expiresAt,
          permissions: minted.success.permissions,
        });
      }
      // A bad key or a missing installation never blocks a member who has their own GitHub.
      yield* Effect.logWarning("the GitHub App gave no token; trying the thread owner's GitHub", {
        sandboxId,
        repository,
        reason: minted.failure.reason,
        detail: minted.failure.detail,
      });
    }
    if (ownerId === null) return Option.none<PickedCredential>();
    const own = yield* members.credentialFor(ownerId);
    return Option.isSome(own) && own.value.host === HOST
      ? Option.some<PickedCredential>({
          source: own.value.source === "token" ? "member-token" : "member-account",
          password: own.value.token,
          expiresAt: null,
        })
      : Option.none<PickedCredential>();
  });

  /** One `GET /repos/{fork}` with the project's credential; a positive answer holds per sandbox. */
  const isForkOf = Effect.fn("GitCredentialService.isForkOf")(function* (
    sandboxId: SandboxId,
    fork: string,
    project: string,
    credential: PickedCredential,
  ) {
    const key = `${sandboxId}\u0000${fork}`;
    if ((yield* Ref.get(verifiedForks)).has(key)) return true;
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(`https://api.${HOST}/repos/${fork}`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            authorization: `Bearer ${Redacted.value(credential.password)}`,
            "user-agent": "t3code",
          }),
        ),
      )
      .pipe(Effect.timeout(REQUEST_TIMEOUT));
    if (response.status === 404) return false;
    if (response.status !== 200) {
      return yield* new ForkCheckError({ status: response.status });
    }
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RepositoryResponse)),
    );
    const isFork = body.parent?.full_name.toLowerCase() === project;
    if (isFork) yield* Ref.update(verifiedForks, (current) => new Set(current).add(key));
    return isFork;
  });

  /**
   * The asking thread's audit event, never the value. The id makes one event per token (or per
   * generation for the owner's own GitHub), so cached answers add nothing.
   */
  const record = Effect.fn("GitCredentialService.record")(
    function* (picked: PickedCredential, context: AnswerContext) {
      const expiresAt = picked.expiresAt === null ? null : DateTime.formatIso(picked.expiresAt);
      const fields = {
        threadId: context.threadId,
        sandboxId: context.sandboxId,
        source: picked.source,
        repository: context.repository,
        expiresAt,
      };
      yield* Effect.logInfo("Issued a git credential", fields);
      yield* orchestrator.dispatch({
        type: "sandbox.git-credential.record",
        commandId: CommandId.make(
          `sandbox-git-credential:${context.sandboxId}:${context.generation}:${context.threadId}:${context.repository}:${expiresAt ?? picked.source}`,
        ),
        ...fields,
        host: HOST,
        ...(picked.permissions === undefined ? {} : { permissions: picked.permissions }),
      });
    },
    (effect, _picked, context) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record a git credential's audit event", {
            threadId: context.threadId,
            sandboxId: context.sandboxId,
            cause,
          }),
        ),
      ),
  );

  const toAnswer = Effect.fn("GitCredentialService.toAnswer")(function* (
    picked: Option.Option<PickedCredential>,
    context: AnswerContext,
  ) {
    if (Option.isNone(picked)) return MISSING;
    yield* record(picked.value, context);
    return {
      _tag: "Credential",
      username: "x-access-token",
      password: picked.value.password,
      expiresAt: picked.value.expiresAt,
    } satisfies RunnerGitCredentialAnswer;
  });

  const answer: GitCredentialService["Service"]["answer"] = Effect.fn(
    "GitCredentialService.answer",
  )(
    function* (input) {
      if (input.protocol !== "https" || input.host.toLowerCase() !== HOST) {
        return refused("unsupported-host", "Pushing from cloud supports github.com only, for now.");
      }
      const sandbox = yield* projections.getSandbox(input.sandboxId);
      if (sandbox === null) return NOT_THIS_THREAD;
      const threadId = input.threadId ?? sandbox.ownerThreadId;
      const attached = yield* projections.listSandboxThreads(input.sandboxId);
      if (!attached.some((row) => row.threadId === threadId)) return NOT_THIS_THREAD;
      const thread = yield* projections.getThread(threadId);
      const project = yield* projectRepository(sandbox.projectId);
      const requested = repositoryFromPath(input.path);
      if (project === null) {
        return refused(
          "not-this-repository",
          "This project has no github.com repository to push to.",
        );
      }
      const notThisRepository = refused(
        "not-this-repository",
        `Cloud threads push only to ${project} and its forks.`,
      );
      if (requested === null) return notThisRepository;
      const context: AnswerContext = {
        sandboxId: input.sandboxId,
        generation: sandbox.generation,
        threadId,
        repository: requested,
      };
      const ownerId = thread.ownerId ?? null;
      const forProject = yield* pick(input.sandboxId, ownerId, project);
      if (requested === project) return yield* toAnswer(forProject, context);
      if (Option.isNone(forProject)) return MISSING;
      if (!(yield* isForkOf(input.sandboxId, requested, project, forProject.value))) {
        return notThisRepository;
      }
      return yield* toAnswer(yield* pick(input.sandboxId, ownerId, requested), context);
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeout(ANSWER_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not answer a sandbox git credential request", {
            sandboxId: input.sandboxId,
            cause,
          }).pipe(Effect.as(UNAVAILABLE)),
        ),
      ),
  );

  return GitCredentialService.of({ answer });
});

export const layer = Layer.effect(GitCredentialService, make);
