// Plain `process.env`: this runs before Effect and the runner's config exist, as in `src/bin.ts`.
const profiling = Boolean(process.env.T3CODE_STARTUP_PROFILE_DIR);

if (profiling) performance.mark("runner.start");

const measured = new Set<string>();

/**
 * With `T3CODE_STARTUP_PROFILE_DIR` set, records the time from `runner.start` to now as a measure
 * (`vp run profile:startup` writes measures out). Each name is recorded once per process.
 */
export const measureRunnerStartup = (name: string, start?: number): void => {
  if (!profiling || measured.has(name)) return;
  measured.add(name);
  performance.measure(name, { start: start ?? "runner.start" });
};
