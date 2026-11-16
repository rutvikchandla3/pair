import type { ChatImageAttachment, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useAssetUrls } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { AttachmentImage } from "../media/AttachmentImage";

/** A post's images: one keeps its shape, several sit in a two-column grid. */
export function SpacePostImages(props: {
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
