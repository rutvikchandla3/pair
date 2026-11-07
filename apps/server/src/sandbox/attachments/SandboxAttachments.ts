// @effect-diagnostics nodeBuiltinImport:off -- sandbox paths are POSIX on every server.
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import { SANDBOX_ROOT, WorkspaceHostUnavailableError } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";

const COPY_CONCURRENCY = 4;

/** Where a sandbox keeps the attachments of its threads (README P1). */
export const sandboxAttachmentsDirectory = (sandboxId: string) =>
  `${SANDBOX_ROOT}/${sandboxId}/attachments`;

/** /t3-sandbox/<id>/attachments/<thread segment>/<id><ext> (P1). Null when the server path is. */
export const sandboxAttachmentPath = (
  sandboxId: string,
  attachment: ChatAttachment,
): string | null => {
  const relative = attachmentRelativePath(attachment);
  const segment = parseThreadSegmentFromAttachmentId(attachment.id);
  return relative === null || segment === null
    ? null
    : `${sandboxAttachmentsDirectory(sandboxId)}/${segment}/${relative}`;
};

/**
 * The extracted-text lookup for prompts that name sandbox paths: the `.txt` lives on the server
 * beside the original, found by file name, and the prompt names its staged copy.
 */
export const resolveSandboxExtractedTextPath = (attachmentsDir: string) =>
  Effect.fn("SandboxAttachments.resolveExtractedTextPath")(function* (sandboxPath: string) {
    const serverPath = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: NodePath.posix.basename(sandboxPath),
    });
    if (serverPath === null) return undefined;
    const extracted = yield* DocumentText.resolveExtractedTextPath(serverPath);
    return extracted === undefined ? undefined : `${sandboxPath}.txt`;
  });

export class SandboxAttachmentStagingError extends Schema.TaggedError<SandboxAttachmentStagingError>()(
  "SandboxAttachmentStagingError",
  { attachmentId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not copy an attachment to the machine. Retry the message.";
  }
}

export class SandboxAttachmentStaging extends Context.Service<
  SandboxAttachmentStaging,
  {
    /** Copies the attachments, and their extracted text, to the machine `cwd` lives on. */
    readonly stage: (input: {
      readonly cwd: string | null;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }) => Effect.Effect<void, SandboxAttachmentStagingError | WorkspaceHostUnavailableError>;
  }
>()("t3/sandbox/attachments/SandboxAttachments/SandboxAttachmentStaging") {}

interface StagedFile {
  readonly attachmentId: string;
  readonly source: string;
  readonly target: string;
}

export const layer = Layer.effect(
  SandboxAttachmentStaging,
  Effect.gen(function* () {
    const hosts = yield* WorkspaceHosts.WorkspaceHosts;
    const fileSystem = yield* FileSystem.FileSystem;
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;

    // A file the server no longer has stages nothing: the prompt still names its path.
    const sourceSize = (file: StagedFile) =>
      fileSystem.stat(file.source).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      );

    const stage: SandboxAttachmentStaging["Service"]["stage"] = Effect.fn(
      "SandboxAttachmentStaging.stage",
    )(function* ({ cwd, attachments }) {
      if (cwd === null || attachments.length === 0) return;
      const host = yield* hosts.forPath(cwd);
      if (host.kind !== "sandbox") return;

      const files = (yield* Effect.forEach(attachments, (attachment) => {
        const source = resolveAttachmentPath({ attachmentsDir, attachment });
        const target = sandboxAttachmentPath(host.id, attachment);
        if (source === null || target === null) return Effect.succeed([]);
        return DocumentText.resolveExtractedTextPath(source).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.map((extracted) => [
            { attachmentId: attachment.id, source, target },
            ...(extracted === undefined
              ? []
              : [{ attachmentId: attachment.id, source: extracted, target: `${target}.txt` }]),
          ]),
        );
      })).flat();

      const stagingError = (file: StagedFile) => (cause: unknown) =>
        new SandboxAttachmentStagingError({ attachmentId: file.attachmentId, cause });

      // The file name is the attachment id, so a target of the same size is this copy. A
      // partial copy is shorter and copies again.
      const missing = (yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
            const size = yield* sourceSize(file);
            if (size === null) return [];
            const staged = yield* host.fileSystem.stat(file.target).pipe(
              Effect.map((info) => Number(info.size)),
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
            );
            return staged === size ? [] : [file];
          }).pipe(Effect.mapError(stagingError(file))),
        { concurrency: COPY_CONCURRENCY },
      )).flat();
      if (missing.length === 0) return;

      // The runner writes as root: agents only read, so folders stay open and files take the umask.
      yield* Effect.forEach(
        new Set(missing.map((file) => NodePath.posix.dirname(file.target))),
        (directory) => host.fileSystem.makeDirectory(directory, { recursive: true, mode: 0o755 }),
        { concurrency: COPY_CONCURRENCY, discard: true },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SandboxAttachmentStagingError({ attachmentId: missing[0]!.attachmentId, cause }),
        ),
      );
      yield* Effect.forEach(
        missing,
        (file) =>
          fileSystem.readFile(file.source).pipe(
            Effect.flatMap((bytes) => host.fileSystem.writeFile(file.target, bytes)),
            Effect.mapError(stagingError(file)),
          ),
        { concurrency: COPY_CONCURRENCY, discard: true },
      );
    });

    return SandboxAttachmentStaging.of({ stage });
  }),
);
