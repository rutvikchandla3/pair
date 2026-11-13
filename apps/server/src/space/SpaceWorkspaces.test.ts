import { assert, it } from "@effect/vitest";
import {
  MemberId,
  type OrchestrationProjectShell,
  type Project,
  ProjectId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SpaceWorkspaces from "./SpaceWorkspaces.ts";

const fe = ProjectId.make("project:pair-fe");
const be = ProjectId.make("project:pair-be");
const docs = ProjectId.make("project:docs");
const actorId = MemberId.make("member:rutvik");

const shell = (
  id: string,
  title: string,
  roots?: ReadonlyArray<ProjectId>,
  extra: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/home/user/${id}`,
  defaultModelSelection: null,
  scripts: [],
  ...(roots === undefined
    ? {}
    : { roots: roots.map((projectId) => ({ projectId, name: projectId })) }),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const repositories = [shell(fe, "pair-fe"), shell(be, "pair-be"), shell(docs, "docs")];

/** A ProjectService over these shells; `create` records what it was asked and `update` dies. */
const projectsOf = (shells: ReadonlyArray<OrchestrationProjectShell>, created: Array<unknown>) =>
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId) =>
      Effect.succeed(
        Option.fromNullishOr(shells.find((candidate) => candidate.id === projectId)).pipe(
          Option.map((found) => ({ ...found, deletedAt: null }) as Project),
        ),
      ),
    listShells: () => Effect.succeed(shells),
    create: (input) =>
      Effect.sync(() => {
        created.push({ title: input.title, roots: input.roots });
        return { ...shell(input.projectId, input.title), deletedAt: null } as Project;
      }),
  });

const run = <A, E>(
  shells: ReadonlyArray<OrchestrationProjectShell>,
  body: (
    workspaces: SpaceWorkspaces.SpaceWorkspaces["Service"],
    created: Array<unknown>,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
  const created: Array<unknown> = [];
  return Effect.gen(function* () {
    const workspaces = yield* SpaceWorkspaces.SpaceWorkspaces;
    return yield* body(workspaces, created);
  }).pipe(
    Effect.provide(
      SpaceWorkspaces.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            projectsOf(shells, created),
            IdAllocator.layer,
            SqlitePersistence.layerMemory,
          ),
        ),
      ),
    ),
  );
};

const threadIn = (projectId: ProjectId, updatedAt: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
      VALUES (${`thread:${projectId}:${updatedAt}`}, ${projectId}, 'Work', 'codex', 'full-access',
        'default', ${updatedAt}, ${updatedAt}, '{}')
    `,
  );

it.effect("one repository runs there; 2+ reuse a workspace with exactly that set", () =>
  Effect.gen(function* () {
    const stack = shell("project:qc-stack", "QC stack", [be, fe]);
    const superset = shell("project:all", "Everything", [fe, be, docs]);
    const archived = shell("project:old", "Old", [fe, be], {
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    const shells = [...repositories, stack, superset, archived];
    const previews = yield* run(shells, (workspaces) =>
      Effect.all([
        workspaces.preview({ repositoryIds: [be], spaceName: "Billing" }),
        workspaces.preview({ repositoryIds: [fe, be], spaceName: "Question creation" }),
      ]),
    );
    assert.deepStrictEqual(previews, [
      { type: "project", projectId: be, title: "pair-be" },
      { type: "reuse", projectId: stack.id, title: "QC stack" },
    ]);
    const refused = yield* run(shells, (workspaces) =>
      Effect.flip(workspaces.preview({ repositoryIds: [stack.id], spaceName: "Nested" })),
    );
    assert.strictEqual(refused.reason, "not-allowed");
  }),
);

it.effect("ties go to the space's name, then the most recently used workspace", () =>
  Effect.gen(function* () {
    const older = shell("project:a", "Stack A", [fe, be], {
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const used = shell("project:b", "Stack B", [fe, be]);
    const named = shell("project:c", "question creation", [be, fe]);
    const [byName, byUse] = yield* run([...repositories, older, used, named], (workspaces) =>
      Effect.gen(function* () {
        yield* threadIn(used.id, "2026-06-01T00:00:00.000Z");
        return [
          yield* workspaces.preview({ repositoryIds: [fe, be], spaceName: "Question Creation" }),
          yield* workspaces.preview({ repositoryIds: [fe, be], spaceName: "Billing" }),
        ];
      }),
    );
    assert.strictEqual(byName?.type === "reuse" ? byName.projectId : null, named.id);
    assert.strictEqual(byUse?.type === "reuse" ? byUse.projectId : null, used.id);
  }),
);

it.effect("no match creates one, suffixing a clashing title; a reused one is never edited", () =>
  Effect.gen(function* () {
    const clash = shell("project:clash", "Question creation");
    const { preview, resolved, created } = yield* run([...repositories, clash], (workspaces, log) =>
      Effect.gen(function* () {
        const input = { repositoryIds: [fe, be], spaceName: "Question creation" };
        return {
          preview: yield* workspaces.preview(input),
          resolved: yield* workspaces.resolve({ ...input, actorId }),
          created: log,
        };
      }),
    );
    assert.deepStrictEqual(preview, { type: "create", title: "Question creation 2" });
    assert.isTrue(resolved.created);
    assert.deepStrictEqual(created, [
      { title: "Question creation 2", roots: [{ projectId: fe }, { projectId: be }] },
    ]);

    const stack = shell("project:qc-stack", "QC stack", [fe, be]);
    const reused = yield* run([...repositories, stack], (workspaces, log) =>
      Effect.map(
        workspaces.resolve({
          repositoryIds: [be, fe],
          spaceName: "Settings rename",
          workspaceName: "Ignored",
          actorId,
        }),
        (result) => ({ result, created: log }),
      ),
    );
    assert.deepStrictEqual(reused, {
      result: { projectId: stack.id, created: false },
      created: [],
    });
  }),
);
