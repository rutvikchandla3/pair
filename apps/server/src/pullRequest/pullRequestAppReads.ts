import { ActingSourceControlCredential } from "@t3tools/source-control-core/server/ActingSourceControlCredential";
import type {
  PullRequestProviderApi,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { PinnedGitHubCredential } from "@t3tools/source-control-github/server/requestPolicy";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { GitHubAppInstallationTokens } from "../sandbox/credentials/GitHubAppInstallationTokens.ts";

type InstallationTokens = GitHubAppInstallationTokens["Service"];

const APP_HOST = "github.com";

/** The server's own credential has nothing for the repository, or cannot see it. */
const appMayServe = (error: PullRequestProviderError) =>
  error.reason === "missing-tool" ||
  error.reason === "unauthenticated" ||
  error.reason === "not-found" ||
  error.reason === "forbidden";

/** The App's read-only pin for `repository`, or none when the App is unset or does not cover it. */
export const appReadCredential = Effect.fnUntraced(function* (
  tokens: InstallationTokens,
  repository: string,
) {
  if (!(yield* tokens.configured)) return Option.none();
  const token = yield* Effect.option(tokens.readTokenFor({ repository }));
  return Option.map(token, (minted) => ({
    host: APP_HOST,
    token: minted.token,
    credentialFingerprint: `${APP_HOST}:installation:${minted.repository}@${DateTime.formatIso(minted.expiresAt)}`,
    source: "installation" as const,
  }));
});

/**
 * Serves a read the server's own GitHub credential cannot with the team's GitHub App, for the one
 * repository the App's token is scoped to. Writes, and every read under a pinned or acting
 * credential, run as they are.
 */
export function withAppReads(
  api: PullRequestProviderApi,
  target: { readonly host: string; readonly repository: string },
  tokens: InstallationTokens,
): PullRequestProviderApi {
  if (target.host !== APP_HOST) return api;
  const own = target.repository.toLowerCase();
  const serve = <A>(
    repositories: ReadonlyArray<string>,
    read: Effect.Effect<A, PullRequestProviderError>,
  ): Effect.Effect<A, PullRequestProviderError> =>
    // A token scoped to one repository must not answer for another.
    repositories.some((repository) => repository.toLowerCase() !== own)
      ? read
      : Effect.gen(function* () {
          if ((yield* PinnedGitHubCredential) !== null) return yield* read;
          if ((yield* ActingSourceControlCredential) !== null) return yield* read;
          return yield* read.pipe(
            Effect.catchIf(appMayServe, (error) =>
              appReadCredential(tokens, own).pipe(
                Effect.flatMap((pin) =>
                  Option.isNone(pin)
                    ? Effect.fail(error)
                    : read.pipe(Effect.provideService(PinnedGitHubCredential, pin.value)),
                ),
              ),
            ),
          );
        });
  const ref =
    <I extends { readonly repository: string }, A>(
      call: (input: I) => Effect.Effect<A, PullRequestProviderError>,
    ) =>
    (input: I) =>
      serve([input.repository], call(input));
  const many =
    <I, A>(
      repositoriesOf: (input: I) => ReadonlyArray<string>,
      call: (input: I) => Effect.Effect<A, PullRequestProviderError>,
    ) =>
    (input: I) =>
      serve(repositoriesOf(input), call(input));

  return {
    ...api,
    getViewer: (input) => serve([own], api.getViewer(input)),
    listChangeRequests: ref(api.listChangeRequests),
    ...(api.listChangeRequestsAcross === undefined
      ? {}
      : {
          listChangeRequestsAcross: many(
            (input) => input.repositories,
            api.listChangeRequestsAcross,
          ),
        }),
    ...(api.listChangeRequestStats === undefined
      ? {}
      : {
          listChangeRequestStats: many(
            (input) => input.changeRequests.map((changeRequest) => changeRequest.repository),
            api.listChangeRequestStats,
          ),
        }),
    getChangeRequest: ref(api.getChangeRequest),
    ...(api.getChangeRequestPreview === undefined
      ? {}
      : { getChangeRequestPreview: ref(api.getChangeRequestPreview) }),
    ...(api.getChangeRequestChecks === undefined
      ? {}
      : { getChangeRequestChecks: ref(api.getChangeRequestChecks) }),
    ...(api.getChangeRequestSummary === undefined
      ? {}
      : { getChangeRequestSummary: ref(api.getChangeRequestSummary) }),
    ...(api.getChangeRequestStack === undefined
      ? {}
      : { getChangeRequestStack: ref(api.getChangeRequestStack) }),
    ...(api.getChangeRequestWatchFingerprint === undefined
      ? {}
      : { getChangeRequestWatchFingerprint: ref(api.getChangeRequestWatchFingerprint) }),
    getChangeRequestActivity: ref(api.getChangeRequestActivity),
    ...(api.getReviewThreadComments === undefined
      ? {}
      : { getReviewThreadComments: ref(api.getReviewThreadComments) }),
    getViewerPermissions: ref(api.getViewerPermissions),
    getDiff: ref(api.getDiff),
    ...(api.getDiffFilePaths === undefined ? {} : { getDiffFilePaths: ref(api.getDiffFilePaths) }),
    ...(api.getDiffFileContents === undefined
      ? {}
      : { getDiffFileContents: ref(api.getDiffFileContents) }),
    ...(api.getFilesViewed === undefined ? {} : { getFilesViewed: ref(api.getFilesViewed) }),
    ...(api.getFileStats === undefined ? {} : { getFileStats: ref(api.getFileStats) }),
    ...(api.getFileRevisions === undefined ? {} : { getFileRevisions: ref(api.getFileRevisions) }),
  } satisfies PullRequestProviderApi;
}
