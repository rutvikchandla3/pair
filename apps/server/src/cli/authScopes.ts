import { AuthGrantScope } from "@t3tools/contracts";
import { Flag } from "effect/cli";

const scopesFlag = (description: string) =>
  Flag.Literals("scope", AuthGrantScope.literals).pipe(
    Flag.withDescription(description),
    Flag.atLeast(0),
    Flag.map((scopes) => [...new Set(scopes)]),
  );

export const authScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  scopesFlag(
    `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
  ).pipe(Flag.map((scopes) => (scopes.length > 0 ? scopes : defaults)));

/** Empty when no scope was passed, since the default is the `--member`'s role. */
export const memberScopesFlag = scopesFlag(
  "Authorization scope to grant. Repeat for multiple scopes; replaces the default set, every scope the member's role grants. Must stay within that role.",
);
