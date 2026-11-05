import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

/** `monochrome` draws both brackets in `currentColor`, for icon slots that are one colour. */
export function PairMark({
  monochrome = false,
  ...props
}: SVGProps<SVGSVGElement> & { readonly monochrome?: boolean }) {
  return (
    <svg {...props} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4H20V10H10V20H4Z" fill="currentColor" />
      <path
        d="M28 28H12V22H22V12H28Z"
        className={monochrome ? undefined : "fill-pair-mark"}
        fill="currentColor"
      />
    </svg>
  );
}

export function PairLockup({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center text-foreground", className)}
      style={{ gap: "0.3cap" }}
      role="img"
      aria-label="Pair"
    >
      {/* The 32 box pads the mark by 4 a side, so 1.5cap draws it at 1.15× cap height. */}
      <PairMark className="h-[1.5cap] w-auto shrink-0" aria-hidden />
      <span
        className="font-semibold [text-box:trim-both_cap_alphabetic]"
        style={{ letterSpacing: "-0.01em" }}
      >
        Pair
      </span>
    </span>
  );
}
