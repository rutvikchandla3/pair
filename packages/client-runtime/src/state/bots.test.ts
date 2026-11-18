import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { createBotsEnvironmentAtoms } from "./bots.ts";

describe("createBotsEnvironmentAtoms", () => {
  it("builds the snapshot and one command per mutation", () => {
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        {} as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
    );
    const atoms = createBotsEnvironmentAtoms(runtime);
    expect(atoms.snapshot).toBeDefined();
    expect(atoms.create).toBeDefined();
    expect(atoms.update).toBeDefined();
    expect(atoms.pause).toBeDefined();
    expect(atoms.resume).toBeDefined();
    expect(atoms.remove).toBeDefined();
    expect(atoms.markSeen).toBeDefined();
    expect(atoms.createJob).toBeDefined();
    expect(atoms.stopJob).toBeDefined();
    expect(atoms.reopenJob).toBeDefined();
    expect(atoms.answerAsk).toBeDefined();
    expect(atoms.rememberAsk).toBeDefined();
    expect(atoms.correctDecision).toBeDefined();
    expect(atoms.handBackSession).toBeDefined();
    expect(atoms.updateNote).toBeDefined();
    expect(atoms.deleteNote).toBeDefined();
  });
});
