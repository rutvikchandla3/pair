// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; every request compares the token synchronously.
import * as NodeCrypto from "node:crypto";
import * as Mac from "effect/crypto/Mac";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

/** The person the Builder proxy signed in: base64url JSON `{ id, name, login, avatar_url }`. */
export const PAIR_USER_HEADER = "x-pair-user";

const MAX_HEADER_LENGTH = 4096;
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 120;

export interface PairBuilderPerson {
  readonly id: string;
  readonly name: string;
}

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const PairUserHeaderJson = Schema.Struct({
  id: Schema.String,
  name: OptionalText,
  login: OptionalText,
  avatar_url: OptionalText,
});
const decodePairUserHeaderJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PairUserHeaderJson),
);

const singleLine = (value: string | null | undefined) => value?.replace(/\s+/gu, " ").trim() ?? "";

/** Anything malformed is no identity, never an error: the header comes from the network. */
export function decodePairUserHeader(raw: string | undefined): Option.Option<PairBuilderPerson> {
  if (raw === undefined || raw.length > MAX_HEADER_LENGTH) return Option.none();
  const json = Base64Url.decodeString(raw.trim());
  if (Result.isFailure(json)) return Option.none();
  return decodePairUserHeaderJson(json.success).pipe(
    Option.flatMap((user) => {
      const id = user.id.trim();
      if (id.length === 0 || id.length > MAX_ID_LENGTH) return Option.none();
      const name = singleLine(user.name) || singleLine(user.login) || id;
      return Option.some({ id, name: Array.from(name).slice(0, MAX_NAME_LENGTH).join("") });
    }),
  );
}

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

/** Compares hashes, so the comparison takes the same time whatever the candidate's length. */
export function makeIngressTokenMatcher(token: Redacted.Redacted<string>) {
  const expected = sha256(Redacted.value(token));
  return (request: HttpServerRequest.HttpServerRequest): boolean => {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer[ \t]+(\S+)[ \t]*$/iu.exec(header) : null;
    return match?.[1] !== undefined && Mac.timingSafeEqual(expected, sha256(match[1]));
  };
}
