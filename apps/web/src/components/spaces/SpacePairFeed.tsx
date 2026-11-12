import type { EnvironmentId, SpaceId } from "@t3tools/contracts";

/**
 * The seam for `@pair` in the room feed: records, confirm cards, receipts and queue lines
 * (screens 5, 5b and 10). The feed merges these items by `createdAt` and renders each with
 * `SpacePairFeedRow`. Their contracts are not settled yet, so there are none today.
 */
export interface SpacePairFeedItem {
  readonly key: string;
  readonly createdAt: string;
}

const NO_ITEMS: ReadonlyArray<SpacePairFeedItem> = [];

export function spacePairFeedItems(
  _environmentId: EnvironmentId,
  _spaceId: SpaceId,
): ReadonlyArray<SpacePairFeedItem> {
  return NO_ITEMS;
}

export function SpacePairFeedRow(_props: { readonly item: SpacePairFeedItem }) {
  return null;
}
