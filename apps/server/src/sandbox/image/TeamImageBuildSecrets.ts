import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

/** Every server-held build secret, in one store entry, so listing them needs no directory scan. */
const STORE_KEY = "team-image-build-secrets";
const RESOURCE = "team image build secrets";

const StoredBuildSecrets = Schema.Record(
  Schema.String,
  Schema.Struct({ value: Schema.String, setAtMs: Schema.Number }),
);
export type StoredBuildSecrets = typeof StoredBuildSecrets.Type;

const StoredBuildSecretsJson = Schema.fromJsonString(StoredBuildSecrets);
const decodeStored = Schema.decodeUnknownOption(StoredBuildSecretsJson);
const encodeStored = Schema.encodeSync(StoredBuildSecretsJson);

export const read = (store: ServerSecretStore.ServerSecretStore["Service"]) =>
  store.get(STORE_KEY).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<StoredBuildSecrets>({}),
        onSome: (bytes) =>
          Effect.fromOption(decodeStored(new TextDecoder().decode(bytes))).pipe(
            // A parse issue can quote the input, so the cause names nothing from it.
            Effect.mapError(
              () =>
                new ServerSecretStore.SecretStoreDecodeError({
                  resource: RESOURCE,
                  cause: "not a map of build secrets",
                }),
            ),
          ),
      }),
    ),
  );

export const write = (
  store: ServerSecretStore.ServerSecretStore["Service"],
  secrets: StoredBuildSecrets,
) =>
  Object.keys(secrets).length === 0
    ? store.remove(STORE_KEY)
    : store.set(STORE_KEY, new TextEncoder().encode(encodeStored(secrets)));
