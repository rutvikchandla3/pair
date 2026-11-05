import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadPresence } from "~/state/presence";

function typingText(names: ReadonlyArray<string>): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

/** A static line above the composer, positioned so the timeline never reflows. */
export function ComposerTypingLine({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { typing } = useThreadPresence(threadRef);
  if (typing.length === 0) return null;
  return (
    <div
      data-composer-typing-line
      className="pointer-events-none absolute inset-x-0 bottom-full px-3 pb-1"
    >
      <p className="w-fit max-w-full truncate rounded-md bg-background px-1.5 text-muted-foreground text-xs">
        {typingText(typing.map((member) => member.name))}
      </p>
    </div>
  );
}
