# Bots: choose the provider, model and effort per session

Status: plan, 2026-11-19. Builds on [Bots: cloud sessions](./bots-cloud-sessions.md).

## Why

Users already tell their bot which model to use, and the bot can't act on it:

- "Use Opus 5.5 at xhigh with the HA creds." HA is a provider instance on the Pair Cloud,
  `claudeAgent-rutvik-916a`, with the display name "HA".
- "For cloud sessions use the HAP Claude provider."
- "Run Claude sessions on Opus 5.5 at high effort."

Today `bot_start_session` always launches with the bot's per-role default (`bot.models.worker` or
`bot.models.reviewer`, set under _Models…_ in the bot's menu). That costs the user two things:

1. **Whose account pays.** Instances are per-credential, so "HA" or "HAP" decides whose
   subscription or API key a session spends. Model and effort decide how much it spends.
2. **Cloud sessions that work at all.** The per-role default holds _this_ machine's instance ids,
   and instance ids are per environment. A cloud launch forwards the default as it is. When the
   cloud has an instance with the same id (the built-in `claudeAgent`), the session runs on
   whatever account that is there. When it doesn't, `t3_thread_launch` there accepts the id anyway
   and the run fails later with an opaque error. The bot has no way to name the instance the cloud
   really has.

The bot never upgrades the model on its own. A pricier model spends money, which is a
check-with-me limit. It applies what the user named in this request, their instructions or a saved
note, and otherwise leaves the role default.

The fix is small because every piece exists. Threads carry a `ModelSelection`, `t3_thread_launch`
and `delegate_task` take one, and `orchestrator_capabilities` lists each environment's instances,
models and option values.

### Push back

- **The real gap is in `t3_thread_launch`, not in bots.** `delegate_task` checks the instance,
  its health, the model and the options before it launches. `t3_thread_launch` checks nothing, so a
  bad selection fails after the thread exists, for every caller (agents, the CLI, bots). We put the
  check where the launch is admitted. A bot-only pre-check would be a client-side linter with an
  extra round trip.
- **"Unchanged when omitted" holds for everything that works today.** A cloud launch whose
  role-default instance doesn't exist there, or isn't signed in, now fails **at launch** with the
  instances that would work, instead of failing later. We think that is the change the user wants.
- **The brief does not carry a provider catalog.** See _Alternatives_.
- **The per-role defaults don't change.** The server does not translate `bot.models.worker` into a
  cloud instance. Guessing ("same driver, first instance") would silently pick whose account pays.

## Patterns we follow

- **The job names its runtime, and the scheduler checks it against what the target offers.** CI
  jobs do this: GitHub Actions `runs-on` labels, GitLab CI `tags:` plus `image:`, Buildkite agent
  `queue` tags. A job with no selector gets the default. Ours is the bot's per-role model.
- **The server that admits the work validates it.** Kubernetes admission control rejects a bad pod
  spec at the API server, before anything is scheduled. Two known pain points show the cost of
  validating late: a GitHub Actions job whose `runs-on` label matches no runner sits queued with no
  error, and a pod whose `nodeSelector` matches no node sits _Pending_ ("didn't match Pod's node
  affinity/selector"). So `t3_thread_launch` refuses a bad selection itself, before the thread
  exists, and lists the valid choices.
- **Model per agent or task, with reasoning effort as a setting of the model.** The OpenAI Agents
  SDK takes `model` plus `ModelSettings(reasoning={effort})` per agent. Claude Code subagents take
  `model:` in their frontmatter. CrewAI takes an `llm` per agent. In this repo, `delegate_task`
  takes `target.{providerInstanceId, model, options}`, and `t3_thread_launch` takes
  `modelSelection {instanceId, model, options:[{id,value}]}`. We reuse `modelSelection` exactly.
- **Discovery is a list endpoint read on demand** (`GET /v1/models`, the GitHub runners API), not
  something copied into every request. That endpoint is `orchestrator_capabilities` with an
  `environmentId`.

## Alternatives considered

1. **Put each target's providers and models in `bot_brief.cloud`.** The bot would see the choices
   without a second call. But it costs about 4 KB of tokens on every turn, and most turns pick no
   model. It also needs either a network call per brief, which breaks #58's "the brief never waits
   on the cloud", or a cache that goes stale when a provider is signed in or out. Rejected.
2. **Point the bot at `orchestrator_capabilities` with `environmentId`.** It already returns
   instance id, `displayName`, models with labels, option ids and allowed values, and
   `constraints` ("Provider is not authenticated."). The bot calls it only when the user names a
   model, and it reads live state. The bot's home thread has every T3 tool, and #58's brief already
   gives `cloud.environmentId`. **Chosen.**
3. **A bot-side pre-check that reads the target's capabilities before launching.** Its errors would
   be the same, but it adds a round trip and a check-then-launch race. It also fixes only bots.
   Rejected in favour of checking in the launch.
4. **Separate `provider`, `model` and `effort` arguments.** They are friendlier to write, but they
   are a parallel shape that no other launch tool has, and `effort` is one option among several
   (`fastMode` and others). Rejected. The persona shows the effort example.

## API

### `bot_start_session` (MCP, bot home thread only)

```ts
modelSelection?: ModelSelection; // { instanceId, model, options?: [{ id, value }] }, as t3_thread_launch
```

- It applies to local and cloud sessions alike, and replaces the role default for this one session.
  When it's omitted, the launch input is unchanged.
- A cloud session forwards it to `t3_thread_launch` there, which checks it against that
  environment. A local session runs the same check against this server's provider registry before
  `ThreadLaunchService.launch`. Both check whatever selection is launched, the role default
  included, so local and cloud fail the same way.
- The result gains `modelSelection`: what the thread actually runs on.

### `bot_brief`

- Each session gains `modelSelection: ModelSelection | null`. It is null for sessions started
  before this change. The bot uses it to answer "what is that running on?" and to keep a follow-up
  session on the same model.
- `bot` gains `models: { worker, reviewer }`, the role defaults. They are stored on the bot, so
  reading them costs no call. The bot needs them to resolve "Opus at high" without an instance (see
  _Model-facing text_).

### `t3_thread_launch` (every caller)

A given `modelSelection` is checked before the thread is created. The check doesn't run on a replay
(a retried `clientRequestId` keeps the model it started with) or on an inherited selection. It is one
pure function over the provider snapshot and the registered V2 adapters. It checks the instance,
its health, the model and the options. `delegate_task`'s `providerConstraints` and
`invalidOptionSelections` move into that module unchanged, so both tools word their refusals the
same way. Like `delegate_task`, it skips the model check when an instance lists no models, and it
accepts custom models (they are in the list). An id the instance doesn't list is refused, as
`delegate_task` already refuses it: the bot is told the ids that work instead of failing later.

A cloud server validates only once it runs this version. Until the Pair Cloud is updated, a bad
selection still fails late there. Working selections behave the same either way.

### Persisted state

`BotSession` (JSON, so no migration) gains `modelSelection?: ModelSelection`. A new session always
records what it launched with, whether that's the bot's choice or the role default. Old rows decode
without it.

### Failure cases (from `t3_thread_launch`, as `invalid_request`, relayed by the bot)

Each message lists what _would_ work, so the bot can fix the call or ask the user in one turn. A
list stops at 8 entries and adds "and N more". An instance is listed only when it can run.

| Case                                      | Message                                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown instance                          | `No provider instance "X" here. Ones that can run: HA (claudeAgent-rutvik-916a), HAP (claudeAgent-rutvik-3c9d), Claude (claudeAgent).`                    |
| Instance can't run (unauthenticated, off) | `HA (claudeAgent-rutvik-916a) can't run here: Provider is not authenticated. Ones that can run: HAP (…), Claude (…).`                                     |
| Model not on that instance                | `HA (claudeAgent-rutvik-916a) has no model "x". Its models: claude-opus-5-5 (Claude Opus 5.5), claude-sonnet-5-5 (Claude Sonnet 5.5), ….`                 |
| Unknown option id or invalid value        | `claude-opus-5-5 on HA rejected options: Option effort must be one of: low, medium, high, xhigh, max, ultracode, ultrathink.` (`delegate_task`'s wording) |
| Instance turned off for that project      | Unchanged: the launch already refuses it (`ThreadManagementProviderInstanceDisabledError`, mapped to `invalid_request`).                                  |
| Cloud unreachable or link expired         | Unchanged from #58: `Could not start the session on <label>: <reason>`, with an expired link mapped as `capability_denied`.                               |

Through the link, #58's `cloudFailure` already prefixes the cloud's message with "on \<label\>", so
"here" reads correctly in context.

## Design review

A senior product-designer reviewer rated the first draft 3.4/5. It said: validate in
`t3_thread_launch`, not in a bot-only pre-check; don't leave the bot to guess the instance; and the
late failure on an omitted cloud selection should become an early one. This revision rates
4.2/5. Its follow-ups are folded in above: the model check stays as permissive as
`delegate_task`'s, the default-instance rule is local-only, both paths check the launched
selection, a null `environmentId` is left out, and the V2 adapter check is included. It agreed
with declining a stored display label.

## Model-facing text

- **The `bot_start_session` description** gains one sentence: "Pass modelSelection when the user
  names a provider, model or effort; get the ids from orchestrator_capabilities (with bot_brief's
  cloud.environmentId for a cloud session, left out when it is null)."
- **The persona** gains one short paragraph under _New work from the user_:
  - Apply the provider, model and effort that the user's message, instructions or a note name, to
    every session of that job, the reviewer included, unless they said otherwise. Never pick a
    pricier model on your own.
  - Find the instance in `orchestrator_capabilities` by its display name, matched exactly and
    ignoring case ("HA" is not "HAP").
  - When no instance is named, a session on this machine keeps your role default's instance
    (bot_brief `bot.models`) if it offers the model. A cloud session's default is this machine's
    id, so it gets no such shortcut. Otherwise, if exactly one instance that can run offers it, use
    that one. Otherwise, `bot_ask` with those instances as options.
  - Effort goes in `options: [{ id: "effort", value: "xhigh" }]`.
  - Otherwise leave `modelSelection` out. A standing rule gets saved with `bot_learn`, which the
    existing preference rule already covers.
- **Evals:** no eval covers the bot persona (as noted in #58). Building and running one calls paid
  models, so we ask before doing it. The handler tests cover the schema; the persona text is
  copy, which the repo's test rules leave untested.

## Surfaces

- **Clients:** none. A session's thread already shows its model when opened, and the bot reports it
  in chat. There is no new UI copy.
- **Providers:** provider-agnostic. The check reads the generic provider snapshot.
- **Agents/MCP:** every `t3_thread_launch` caller gains the check. A user starting threads by hand
  picks from the composer, which only offers valid choices.
- **Connection modes:** local, and a linked cloud through the link. On a server that runs cloud
  machines itself, a `cloud` session is local and gets the local check.

## Tests

- **A model-selection check test (new, pure):** each failure row above, and an accepted selection.
- **`t3_thread_launch` (the existing project-toolkit tests):** a bad `modelSelection` creates no
  thread, and a replay with a stored selection isn't re-checked.
- **`BotSessions.test.ts`:**
  - A local start with `modelSelection` launches with it and records it.
  - A cloud start forwards it and records the launch's answer.
  - A rejected local selection launches nothing.
  - An omitted `modelSelection` keeps today's launch input.
- **`handlers.test.ts`:** the brief shows each session's `modelSelection` and the bot's role
  defaults.
- **Fixtures:** the peer and link-origin tests launch on a box with no providers, so their boxes
  gain the provider they launch with (`ProviderRegistry.testkit.ts`).

## Not in this change

- A per-bot "cloud default model" setting. A saved note covers it for now.
- Translating the role defaults across environments.
- Moving `delegate_task`'s instance and model checks onto the shared function. Only its two
  helpers move here.
- A display label stored on the session. The brief gives ids, and `orchestrator_capabilities` maps
  them to names when the bot needs one.
- Machine size (still the cloud's default, as in #58).
