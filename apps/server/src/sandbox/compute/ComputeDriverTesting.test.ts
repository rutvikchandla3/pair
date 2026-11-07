import * as Effect from "effect/Effect";

import { computeDriverContract } from "./computeDriverContract.ts";
import * as ComputeDriverTesting from "./ComputeDriverTesting.ts";

computeDriverContract("FakeComputeDriver", () =>
  Effect.gen(function* () {
    const fake = yield* ComputeDriverTesting.make();
    yield* Effect.forkScoped(ComputeDriverTesting.answerFromMemory(fake.calls));
    return fake.driver;
  }),
);
