import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  SPACE_POST_MAX_ATTACHMENTS,
  isProviderSendTurnSupportedImageMimeType,
} from "@t3tools/contracts";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { useTheme } from "../../hooks/useTheme";
import {
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { ComposerImageThumbnail } from "../chat/ComposerImageThumbnail";
import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export type SpaceDraftAttachment = ComposerImageAttachment | ComposerFileAttachment;

const prepareImage = async (
  file: File,
): Promise<ComposerImageAttachment | { readonly problem: string }> => {
  const result = await prepareImageForAttachment(
    normalizeComposerImageFileMimeType(file),
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
  if (!result.ok || !isProviderSendTurnSupportedImageMimeType(result.file.type)) {
    return {
      problem:
        result.ok || result.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach.`,
    };
  }
  return {
    type: "image",
    id: randomUUID(),
    name: file.name || "image",
    mimeType: result.file.type,
    sizeBytes: result.file.size,
    previewUrl: URL.createObjectURL(result.file),
    file: result.file,
  };
};

const prepareFile = (file: File): ComposerFileAttachment | { readonly problem: string } => {
  if (file.size <= 0) return { problem: `'${file.name}' is empty or could not be read.` };
  if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return {
      problem: `'${file.name}' is larger than ${formatAttachmentSize(PROVIDER_SEND_TURN_MAX_FILE_BYTES)}.`,
    };
  }
  const mimeType = composerFileAttachmentMimeType(file);
  const staged =
    file.type === mimeType
      ? file
      : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
  return {
    type: "file",
    id: randomUUID(),
    name: file.name || "file",
    mimeType,
    sizeBytes: staged.size,
    file: staged,
  };
};

/** Prepares and starts uploading `files`, up to `room` of them; says why any were left out. */
export async function prepareSpaceAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly files: ReadonlyArray<File>;
  readonly room: number;
}): Promise<ReadonlyArray<SpaceDraftAttachment>> {
  const problems: Array<string> = [];
  if (input.files.length > input.room) {
    problems.push(`A message holds up to ${SPACE_POST_MAX_ATTACHMENTS} attachments.`);
  }
  const prepared: Array<SpaceDraftAttachment> = [];
  for (const file of input.files.slice(0, Math.max(0, input.room))) {
    const kind = classifyComposerAttachmentFile(file);
    const result =
      kind === "image"
        ? await prepareImage(file)
        : kind === "file"
          ? prepareFile(file)
          : { problem: `'${file.name}' is not a supported image type.` };
    if ("problem" in result) {
      problems.push(result.problem);
      continue;
    }
    startAttachmentUpload({ environmentId: input.environmentId, image: result });
    prepared.push(result);
  }
  if (problems.length > 0) {
    toastManager.add({ type: "warning", title: problems.join(" ") });
  }
  return prepared;
}

/** Cancels or deletes each upload and frees image previews. */
export function releaseSpaceAttachments(attachments: ReadonlyArray<SpaceDraftAttachment>): void {
  for (const attachment of attachments) {
    releaseAttachmentUpload(attachment.id);
    if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function SpaceComposerAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<SpaceDraftAttachment>;
  readonly onRemove: (attachment: SpaceDraftAttachment) => void;
}) {
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  if (props.attachments.length === 0) return null;
  const images = props.attachments.filter(
    (attachment): attachment is ComposerImageAttachment => attachment.type === "image",
  );
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pt-3">
      {props.attachments.map((attachment) =>
        attachment.type === "image" ? (
          <SpaceComposerImage
            key={attachment.id}
            environmentId={props.environmentId}
            image={attachment}
            onOpen={() => setPreview(buildExpandedImagePreview(images, attachment.id))}
            onRemove={() => props.onRemove(attachment)}
          />
        ) : (
          <SpaceComposerFile
            key={attachment.id}
            environmentId={props.environmentId}
            file={attachment}
            onRemove={() => props.onRemove(attachment)}
          />
        ),
      )}
      {preview === null ? null : (
        <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </ul>
  );
}

function RetryUpload(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: SpaceDraftAttachment;
  readonly reason: string;
  readonly className: string;
}) {
  return (
    <Button
      variant="overlay"
      size="icon-xs"
      className={props.className}
      aria-label={`Retry upload for ${props.attachment.name}: ${props.reason}`}
      onClick={() =>
        retryAttachmentUpload({ environmentId: props.environmentId, image: props.attachment })
      }
    >
      <RefreshCwIcon />
    </Button>
  );
}

function SpaceComposerImage(props: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const upload = useAttachmentUploadStore((state) => state.uploadsByImageId[props.image.id]);
  return (
    <li className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background">
      <button
        type="button"
        className="size-full cursor-zoom-in"
        aria-label={`Preview ${props.image.name}`}
        onClick={props.onOpen}
      >
        <ComposerImageThumbnail
          file={props.image.file}
          alt={props.image.name}
          className="size-full object-cover"
          fallback={
            <span className="flex size-full items-center justify-center px-1 text-3xs text-muted-foreground">
              {props.image.name}
            </span>
          }
        />
      </button>
      {upload?.status === "uploading" ? (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs">
          {formatAttachmentUploadProgress(upload.progress)}
        </span>
      ) : null}
      {upload?.status === "failed" ? (
        <RetryUpload
          environmentId={props.environmentId}
          attachment={props.image}
          reason={upload.reason}
          className="absolute bottom-1 left-1"
        />
      ) : null}
      <Button
        variant="overlay"
        size="icon-xs"
        className="absolute top-1 right-1"
        aria-label={`Remove ${props.image.name}`}
        onClick={props.onRemove}
      >
        <XIcon />
      </Button>
    </li>
  );
}

function SpaceComposerFile(props: {
  readonly environmentId: EnvironmentId;
  readonly file: ComposerFileAttachment;
  readonly onRemove: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const upload = useAttachmentUploadStore((state) => state.uploadsByImageId[props.file.id]);
  return (
    <li className="flex h-16 w-52 min-w-0 shrink-0 items-center gap-2.5 rounded-lg border border-border/80 bg-background pr-1 pl-3">
      <PierreEntryIcon pathValue={props.file.name} kind="file" theme={resolvedTheme} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{props.file.name}</span>
        <span className="block text-muted-foreground text-xs">
          {upload?.status === "uploading"
            ? formatAttachmentUploadProgress(upload.progress)
            : upload?.status === "failed"
              ? "Upload failed"
              : formatAttachmentSize(props.file.sizeBytes)}
        </span>
      </span>
      {upload?.status === "failed" ? (
        <RetryUpload
          environmentId={props.environmentId}
          attachment={props.file}
          reason={upload.reason}
          className="shrink-0"
        />
      ) : null}
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 self-start"
        aria-label={`Remove ${props.file.name}`}
        onClick={props.onRemove}
      >
        <XIcon />
      </Button>
    </li>
  );
}
