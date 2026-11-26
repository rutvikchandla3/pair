import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  type LinkedPrompt,
  type NewThreadLink,
  parseNewThreadLink as parseNewThreadLinkWith,
  parseThreadLinkPrompt as parseThreadLinkPromptWith,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  type PromptLinkError,
  type PromptLinkResult,
} from "./promptLinks.ts";

function promptLinkErrorMessage(error: PromptLinkError, resolve: MFunctionType): string {
  switch (error) {
    case "prompt-too-long":
      return `This prompt is longer than ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters, so Pair did not open it.`;
    case "prompt-only-hidden":
      return "This prompt had only hidden characters, so it may be malicious. Pair did not open it.";
    case "unreadable-pull-request":
      return "This link names a pull request Pair cannot read.";
    case "missing-prompt":
      return resolve(msg("This link has no prompt."));
    case "unreadable-repository":
      return "This link names a repository Pair cannot read.";
  }
}

/** @public */
export function parseNewThreadLink(
  search: string,
  resolve: MFunctionType = mFallback,
): PromptLinkResult<NewThreadLink> {
  return parseNewThreadLinkWith(search, (error) => promptLinkErrorMessage(error, resolve));
}

/** @public */
export function parseThreadLinkPrompt(
  search: string,
  resolve: MFunctionType = mFallback,
): PromptLinkResult<LinkedPrompt | null> {
  return parseThreadLinkPromptWith(search, (error) => promptLinkErrorMessage(error, resolve));
}
