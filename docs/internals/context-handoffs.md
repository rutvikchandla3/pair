# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

`OrchestrationV2ContextTransfer.sourceThreadId` names a thread in the same event store, so a move
between servers does not use a context transfer. The sending server builds an
`OrchestrationV2ContextExport` that carries its own provenance (environment, thread, title) and the
thread's messages, size-capped; the receiving server imports them as read-only history
(`historyOrigin: "context_export"`) and builds a `manual_context` handoff in
`prepareLegacyImport`'s shape, so the handoff's omitted-history references resolve on the new
thread. Keep exports self-describing: a reference back to the other server's store can't be
followed.

Imported history, from a legacy v1 continuation or a context export, uses a separate algorithm. It
considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
