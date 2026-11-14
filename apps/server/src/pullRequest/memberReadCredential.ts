import type { MemberId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MemberGitHub from "../team/MemberGitHub.ts";
import * as TeamMembers from "../team/TeamMembers.ts";
import type { MemberReadCredential } from "./PullRequestService.ts";

/**
 * The reading member's linked GitHub for a pull request on `host`, looked up when a read needs
 * it. A cloud machine pushes with this account when the team's App does not cover the repository.
 */
export const makeMemberReadCredential = Effect.gen(function* () {
  const memberGitHub = yield* MemberGitHub.MemberGitHub;
  const teamMembers = yield* TeamMembers.TeamMembers;
  return (memberId: MemberId, host: string | undefined) =>
    Effect.gen(function* () {
      const credential = yield* memberGitHub.credentialFor(memberId);
      if (Option.isNone(credential)) return Option.none<MemberReadCredential>();
      const { host: credentialHost, token } = credential.value;
      if (host !== undefined && host.toLowerCase() !== credentialHost) {
        return Option.none<MemberReadCredential>();
      }
      const login = (yield* teamMembers.list).find((member) => member.id === memberId)?.github
        ?.login;
      return login === undefined
        ? Option.none<MemberReadCredential>()
        : Option.some<MemberReadCredential>({
            host: credentialHost,
            token,
            login,
            credentialFingerprint: `${credentialHost}:member:${memberId}:${login}`,
          });
    });
});
