import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type {
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  SpacePostAttachments as Attachments,
} from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useAssetUrls } from "../../assets/assetUrls";
import { useTheme } from "../../hooks/useTheme";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { AttachmentImage } from "../media/AttachmentImage";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";

/** A post's attachments: its images, then its files as download links. */
export function SpacePostAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: Attachments;
}) {
  const images = props.attachments.filter(
    (attachment): attachment is ChatImageAttachment => attachment.type === "image",
  );
  const files = props.attachments.filter(
    (attachment): attachment is ChatFileAttachment => attachment.type === "file",
  );
  return (
    <>
      {images.length === 0 ? null : (
        <SpacePostImages environmentId={props.environmentId} images={images} />
      )}
      {files.length === 0 ? null : (
        <SpacePostFiles environmentId={props.environmentId} files={files} />
      )}
    </>
  );
}

function SpacePostFiles(props: {
  readonly environmentId: EnvironmentId;
  readonly files: ReadonlyArray<ChatFileAttachment>;
}) {
  const { resolvedTheme } = useTheme();
  const urls = useAssetUrls(
    props.environmentId,
    props.files.map((file) => ({
      _tag: "attachment",
      attachmentId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      disposition: "attachment",
    })),
  );
  return (
    <ul className="mt-1.5 flex max-w-full flex-wrap gap-1.5">
      {props.files.map((file, index) => {
        const url = urls[index];
        return (
          <li key={file.id} className="min-w-0">
            <a
              href={url ?? undefined}
              download={file.name}
              aria-disabled={url === undefined}
              aria-label={`Download ${file.name}`}
              className={cn(
                "group/file flex w-64 max-w-full items-center gap-2.5 rounded-lg border border-border/80 bg-background px-3 py-2 hover:bg-accent/60",
                url === undefined && "pointer-events-none opacity-60",
              )}
            >
              <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{file.name}</span>
                <span className="block text-muted-foreground text-xs">
                  {formatAttachmentSize(file.sizeBytes)}
                </span>
              </span>
              <DownloadIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground group-hover/file:text-foreground"
              />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** One image keeps its shape; several sit in a two-column grid. */
function SpacePostImages(props: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ChatImageAttachment>;
}) {
  const urls = useAssetUrls(
    props.environmentId,
    props.images.map((image) => ({
      _tag: "attachment",
      attachmentId: image.id,
      fileName: image.name,
      mimeType: image.mimeType,
      disposition: "inline",
    })),
  );
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const lone = props.images.length === 1;
  const open = (index: number) => {
    const ready = props.images.flatMap((image, at) => {
      const src = urls[at];
      return src ? [{ at, src, name: image.name, mimeType: image.mimeType }] : [];
    });
    const selected = ready.findIndex((image) => image.at === index);
    if (selected < 0) return;
    setPreview({ images: ready.map(({ at: _at, ...image }) => image), index: selected });
  };
  return (
    <div className={cn("mt-1.5 grid gap-1.5", lone ? "max-w-80" : "w-80 max-w-full grid-cols-2")}>
      {props.images.map((image, index) => {
        const src = urls[index];
        return (
          <div
            key={image.id}
            className={cn(
              "overflow-hidden rounded-lg border border-border/80 bg-muted/40",
              lone ? "w-fit" : "aspect-[4/3]",
            )}
          >
            {src ? (
              <button
                type="button"
                className="block size-full cursor-zoom-in"
                aria-label={`Preview ${image.name}`}
                onClick={() => open(index)}
              >
                <AttachmentImage
                  name={image.name}
                  mimeType={image.mimeType}
                  src={src}
                  alt={image.name}
                  decoding="async"
                  loading="lazy"
                  className={cn(
                    "block",
                    lone ? "h-auto max-h-60 w-auto max-w-full" : "size-full object-cover",
                  )}
                />
              </button>
            ) : (
              <div
                className={cn(
                  "flex items-center justify-center px-2 text-center text-2xs text-muted-foreground",
                  lone ? "h-24 w-40" : "size-full",
                )}
              >
                {image.name}
              </div>
            )}
          </div>
        );
      })}
      {preview === null ? null : (
        <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
