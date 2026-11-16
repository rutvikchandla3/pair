import {
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  SPACE_POST_MAX_IMAGES,
  isProviderSendTurnSupportedImageMimeType,
} from "@t3tools/contracts";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import {
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
import { isHeicImageFile, prepareImageForAttachment } from "../../lib/imageCompression";
import { ComposerImageThumbnail } from "../chat/ComposerImageThumbnail";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const isImageFile = (file: File) => file.type.startsWith("image/") || isHeicImageFile(file);

/** Compresses and starts uploading the images among `files`; says why any were left out. */
export async function prepareSpaceImages(input: {
  readonly environmentId: EnvironmentId;
  readonly files: ReadonlyArray<File>;
  readonly room: number;
}): Promise<ReadonlyArray<ComposerImageAttachment>> {
  const problems: Array<string> = [];
  const candidates = input.files.filter(isImageFile);
  if (candidates.length < input.files.length) problems.push("Only images can be shared here.");
  if (candidates.length > input.room) {
    problems.push(`A message holds up to ${SPACE_POST_MAX_IMAGES} images.`);
  }
  const prepared: Array<ComposerImageAttachment> = [];
  for (const file of candidates.slice(0, Math.max(0, input.room))) {
    const result = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES).catch(
      () => ({ ok: false, reason: "unreadable" }) as const,
    );
    if (!result.ok || !isProviderSendTurnSupportedImageMimeType(result.file.type)) {
      problems.push(
        result.ok || result.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach.`,
      );
      continue;
    }
    const image: ComposerImageAttachment = {
      type: "image",
      id: randomUUID(),
      name: file.name || "image",
      mimeType: result.file.type,
      sizeBytes: result.file.size,
      previewUrl: URL.createObjectURL(result.file),
      file: result.file,
    };
    startAttachmentUpload({ environmentId: input.environmentId, image });
    prepared.push(image);
  }
  if (problems.length > 0) {
    toastManager.add({ type: "warning", title: problems.join(" ") });
  }
  return prepared;
}

/** Cancels or deletes each upload and frees its preview. */
export function releaseSpaceImages(images: ReadonlyArray<ComposerImageAttachment>): void {
  for (const image of images) {
    releaseAttachmentUpload(image.id);
    URL.revokeObjectURL(image.previewUrl);
  }
}

export function SpaceComposerImages(props: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly onRemove: (image: ComposerImageAttachment) => void;
}) {
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  if (props.images.length === 0) return null;
  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-3 pt-3">
      {props.images.map((image) => (
        <SpaceComposerImage
          key={image.id}
          environmentId={props.environmentId}
          image={image}
          onOpen={() => setPreview(buildExpandedImagePreview(props.images, image.id))}
          onRemove={() => props.onRemove(image)}
        />
      ))}
      {preview === null ? null : (
        <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </ul>
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
        <Button
          variant="overlay"
          size="icon-xs"
          className="absolute bottom-1 left-1"
          aria-label={`Retry upload for ${props.image.name}: ${upload.reason}`}
          onClick={() =>
            retryAttachmentUpload({ environmentId: props.environmentId, image: props.image })
          }
        >
          <RefreshCwIcon />
        </Button>
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
