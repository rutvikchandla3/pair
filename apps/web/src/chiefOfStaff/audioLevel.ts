/** Elements whose `--cos-level` (0 to 1) follows the live voice. */
const levelTargets = new Set<HTMLElement>();
let lastWritten = 0;

function writeLevel(level: number): void {
  lastWritten = level;
  const value = level.toFixed(3);
  for (const element of levelTargets) element.style.setProperty("--cos-level", value);
}

/** A ref callback: the element follows the level while mounted. */
export function chiefOfStaffLevelTarget(element: HTMLElement | null): (() => void) | undefined {
  if (element === null) return undefined;
  levelTargets.add(element);
  element.style.setProperty("--cos-level", lastWritten.toFixed(3));
  return () => {
    levelTargets.delete(element);
  };
}

export interface LevelMeter {
  readonly listenTo: (source: "microphone" | "remote", stream: MediaStream) => void;
  readonly stop: () => void;
}

/**
 * Reads the microphone while the user talks and the reply while it plays, and writes one smoothed
 * level per frame. Runs only for a live session; `stop` ends the loop and rests the level at zero.
 */
export function startLevelMeter(
  context: AudioContext,
  readSource: () => "microphone" | "remote" | null,
): LevelMeter {
  const analysers = new Map<"microphone" | "remote", AnalyserNode>();
  const samples = new Uint8Array(512);
  let level = 0;
  let frame: number | null = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const tick = () => {
    const source = readSource();
    const analyser = source === null ? undefined : analysers.get(source);
    let target = 0;
    if (analyser !== undefined) {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      target = Math.min(1, Math.sqrt(sum / samples.length) * 5);
    }
    level += (target - level) * (target > level ? 0.5 : 0.15);
    if (Math.abs(level - lastWritten) > 0.01) writeLevel(level);
    frame = requestAnimationFrame(tick);
  };
  if (!reducedMotion) frame = requestAnimationFrame(tick);

  return {
    listenTo: (source, stream) => {
      if (analysers.has(source) || stream.getAudioTracks().length === 0) return;
      const analyser = context.createAnalyser();
      analyser.fftSize = samples.length;
      context.createMediaStreamSource(stream).connect(analyser);
      analysers.set(source, analyser);
    },
    stop: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      writeLevel(0);
      void context.close().catch(() => undefined);
    },
  };
}
