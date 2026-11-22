import { BotPicture, BotsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { planAttachmentClaim, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const MIME_BY_EXTENSION: Readonly<Record<string, BotPicture["mimeType"]>> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Stored bot pictures: a pending upload becomes one, and a replaced or removed one is deleted. */
export class BotPictures extends Context.Service<
  BotPictures,
  {
    readonly adopt: (pendingAttachmentId: string) => Effect.Effect<BotPicture, BotsError>;
    readonly discard: (picture: BotPicture) => Effect.Effect<void>;
  }
>()("t3/bots/BotPictures") {}

const make = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const adopt = Effect.fn("BotPictures.adopt")(function* (pendingAttachmentId: string) {
    const invalid = (message: string) => new BotsError({ reason: "invalid-request", message });
    // A shared segment: pictures are not owned by a thread, so thread cleanup never reaches them.
    const claim = planAttachmentClaim({
      attachmentsDir,
      threadId: "bot-picture",
      attachmentId: pendingAttachmentId,
    });
    if (!claim.ok) return yield* invalid(`The picture can't be used: ${claim.reason}.`);
    const mimeType = MIME_BY_EXTENSION[path.extname(claim.finalPath).toLowerCase()];
    if (mimeType === undefined) {
      return yield* invalid("A picture must be a GIF, PNG, JPEG or WebP image.");
    }
    yield* fileSystem
      .rename(claim.currentPath, claim.finalPath)
      .pipe(Effect.mapError(() => invalid("The picture upload is no longer on this machine.")));
    return { attachmentId: claim.finalId, mimeType } satisfies BotPicture;
  });

  const discard = Effect.fn("BotPictures.discard")(function* (picture: BotPicture) {
    const stored = resolveAttachmentPathById({
      attachmentsDir,
      attachmentId: picture.attachmentId,
    });
    if (stored === null) return;
    yield* fileSystem.remove(stored).pipe(Effect.ignore);
  });

  return BotPictures.of({ adopt, discard });
});

export const layer = Layer.effect(BotPictures, make);
