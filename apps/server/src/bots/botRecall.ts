import type { BotAsk, BotId, BotJob, BotNote } from "@t3tools/contracts";
import { BotsError } from "@t3tools/contracts";
import { messageMatcher } from "@t3tools/shared/paletteSearch";
import * as Effect from "effect/Effect";

import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as BotService from "./BotService.ts";

const ANSWER_CHARS = 300;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

type RecallHit = {
  readonly source: "chat" | "job" | "answer" | "note";
  /** When it was written or last changed, ISO. */
  readonly at: string | null;
  readonly text: string;
  readonly quality: number;
} & (
  | { readonly source: "chat"; readonly from: "user" | "you" }
  | { readonly source: "job"; readonly jobId: BotJob["id"]; readonly title: string }
  | { readonly source: "answer"; readonly askId: BotAsk["id"]; readonly jobId: BotJob["id"] | null }
  | { readonly source: "note"; readonly noteId: BotNote["id"] }
);

const jobText = (job: BotJob): string =>
  [
    job.title,
    job.request,
    job.headline,
    job.report?.changed ?? "",
    ...(job.report?.evidence ?? []),
    ...(job.report?.openQuestions ?? []),
    job.pullRequests.map((pr) => pr.url).join(" "),
  ]
    .filter((part) => part.trim() !== "")
    .join("\n");

/** The stored records that match: every job with its report, answered Asks, and notes. */
const recallStored = (
  query: string,
  stored: {
    readonly jobs: ReadonlyArray<BotJob>;
    readonly asks: ReadonlyArray<BotAsk>;
    readonly notes: ReadonlyArray<BotNote>;
  },
): ReadonlyArray<RecallHit> => {
  const match = messageMatcher(query);
  const hits: Array<RecallHit> = [];
  for (const job of stored.jobs) {
    const text = jobText(job);
    const found = match(text);
    if (found === null) continue;
    hits.push({
      source: "job",
      jobId: job.id,
      title: job.title,
      at: job.finishedAt ?? job.updatedAt,
      text: ThreadSearch.buildSearchSnippet(text, found.offset),
      quality: found.quality,
    });
  }
  for (const ask of stored.asks) {
    if (ask.status !== "answered") continue;
    const text = `Q: ${clip(ask.question, ANSWER_CHARS)}\nA: ${clip(ask.answer ?? "They let you decide.", ANSWER_CHARS)}`;
    const found = match(text);
    if (found === null) continue;
    hits.push({
      source: "answer",
      askId: ask.id,
      jobId: ask.jobId,
      at: ask.answeredAt,
      text,
      quality: found.quality,
    });
  }
  for (const note of stored.notes) {
    const found = match(note.text);
    if (found === null) continue;
    hits.push({
      source: "note",
      noteId: note.id,
      at: note.updatedAt,
      text: note.text,
      quality: found.quality,
    });
  }
  return hits;
};

/** Best match first, then the newest. */
const rankRecall = (hits: ReadonlyArray<RecallHit>, limit: number): ReadonlyArray<RecallHit> =>
  hits
    .toSorted(
      (left, right) =>
        right.quality - left.quality || (right.at ?? "").localeCompare(left.at ?? ""),
    )
    .slice(0, limit);

/** What the bot can no longer see that matches `query`: its chat, jobs, answers and notes. */
export const loadRecall = Effect.fn("bots.loadRecall")(function* (
  botId: BotId,
  query: string,
  limit: number,
) {
  const bots = yield* BotService.BotService;
  const search = yield* ThreadSearch.ThreadSearch;
  const snapshot = yield* bots.snapshotForBot(botId);
  const homeThreadId = snapshot.bots[0]?.homeThreadId ?? null;
  const chat =
    homeThreadId === null
      ? []
      : yield* search
          .searchThreadMessages({ threadId: homeThreadId, query, limit })
          .pipe(
            Effect.mapError(
              () =>
                new BotsError({ reason: "unavailable", message: "Could not search this chat." }),
            ),
          );
  const ranked = rankRecall(
    [
      ...chat.map((hit): RecallHit => ({
        source: "chat",
        from: hit.source === "user" ? "user" : "you",
        at: hit.messageCreatedAt,
        text: hit.snippet,
        quality: hit.quality,
      })),
      ...recallStored(query, snapshot),
    ],
    limit,
  );
  return { results: ranked.map(({ quality: _quality, ...hit }) => hit) };
});
