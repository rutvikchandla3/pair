import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  type AtomCommandResult,
  followStreamInEnvironment,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type ChiefOfStaffEvent,
  type ChiefOfStaffSessionId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { chiefOfStaffCommands } from "../state/chiefOfStaff";
import { environmentPresentations } from "../state/presentation";
import { startLevelMeter, type LevelMeter } from "./audioLevel";
import {
  INITIAL_CHIEF_OF_STAFF_VIEW,
  INSECURE_ORIGIN_MESSAGE,
  isChiefOfStaffLive,
  microphoneErrorMessage,
  reduceChiefOfStaff,
  type ChiefOfStaffAction,
  type ChiefOfStaffView,
} from "./chiefOfStaff.logic";

export const useChiefOfStaffStore = create<ChiefOfStaffView>(() => INITIAL_CHIEF_OF_STAFF_VIEW);

function dispatch(action: ChiefOfStaffAction): void {
  useChiefOfStaffStore.setState(reduceChiefOfStaff(useChiefOfStaffStore.getState(), action), true);
}

/** The browser half of the one session this app runs: microphone, peer, playback, subscription. */
interface LiveSession {
  readonly token: number;
  readonly environmentId: EnvironmentId;
  sessionId: ChiefOfStaffSessionId | null;
  microphone: MediaStream | null;
  peer: RTCPeerConnection | null;
  audio: HTMLAudioElement | null;
  meter: LevelMeter | null;
  readonly releases: Array<() => void>;
}

let live: LiveSession | null = null;
let nextToken = 0;
let unloadListening = false;

// The server needs the full offer; trickle ICE has nowhere to go.
const ICE_GATHERING_TIMEOUT_MS = 5_000;
const PEER_FAILED_MESSAGE = "The voice connection dropped. Check your network and start again.";
const ENVIRONMENT_LOST_MESSAGE = "The environment disconnected, so the voice session ended.";

function isCurrent(token: number): boolean {
  return live?.token === token;
}

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  if (result._tag === "Success") return fallback;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function release(session: LiveSession): void {
  for (const releaseOne of session.releases.splice(0)) releaseOne();
  session.meter?.stop();
  session.peer?.close();
  for (const track of session.microphone?.getTracks() ?? []) track.stop();
  if (session.audio !== null) {
    session.audio.pause();
    session.audio.srcObject = null;
  }
}

function sendStop(environmentId: EnvironmentId, sessionId: ChiefOfStaffSessionId): void {
  void runAtomCommand(
    appAtomRegistry,
    chiefOfStaffCommands.stop,
    { environmentId, input: { sessionId } },
    { reportFailure: false },
  );
}

/** Ends the session on this side and tells the server; `message` marks it as a failure. */
function end(token: number, message: string | null): void {
  const session = live;
  if (session === null || session.token !== token) return;
  live = null;
  release(session);
  dispatch(message === null ? { type: "stopped" } : { type: "failed", message });
  if (session.sessionId !== null) sendStop(session.environmentId, session.sessionId);
}

function onEvent(token: number, event: ChiefOfStaffEvent): void {
  if (!isCurrent(token)) return;
  dispatch({ type: "event", event });
  if (event._tag === "state" && event.state === "closed") {
    const session = live!;
    live = null;
    // Leave the stream callback before disposing the atom that runs it.
    queueMicrotask(() => release(session));
  }
}

function followEvents(session: LiveSession, sessionId: ChiefOfStaffSessionId): () => void {
  const { token, environmentId } = session;
  const events = connectionAtomRuntime
    .atom(
      followStreamInEnvironment(
        environmentId,
        subscribe(WS_METHODS.chiefOfStaffSubscribe, { sessionId }),
      ).pipe(
        Stream.takeUntil((event) => event._tag === "state" && event.state === "closed"),
        Stream.runForEach((event) => Effect.sync(() => onEvent(token, event))),
      ),
    )
    .pipe(Atom.withLabel("chief-of-staff:events"));
  // Mounted for the whole session: the server ends a session nobody is subscribed to, and the
  // subscription resubscribes by itself after a reconnect.
  return appAtomRegistry.subscribe(
    events,
    (result) => {
      if (result._tag !== "Failure" || Cause.hasInterruptsOnly(result.cause)) return;
      const error = Cause.squash(result.cause);
      end(
        token,
        error instanceof Error && error.message !== ""
          ? error.message
          : "Lost touch with the voice session.",
      );
    },
    { immediate: true },
  );
}

function watchEnvironment(session: LiveSession): () => void {
  return subscribeAtomChanges(environmentPresentations.presentationsAtom, (presentations) => {
    const phase = presentations.get(session.environmentId)?.connection.phase;
    // Reconnecting keeps the session: audio does not pass through the environment.
    if (
      phase === undefined ||
      phase === "available" ||
      phase === "error" ||
      phase === "unsupported"
    ) {
      end(session.token, ENVIRONMENT_LOST_MESSAGE);
    }
  });
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (peer.iceGatheringState !== "complete" && !timedOut) return;
      peer.removeEventListener("icegatheringstatechange", done);
      clearTimeout(timer);
      resolve();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      done();
    }, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", done);
  });
}

function listenForUnload(): void {
  if (unloadListening) return;
  unloadListening = true;
  window.addEventListener("pagehide", () => {
    if (live !== null) end(live.token, null);
  });
}

export function startChiefOfStaff(environmentId: EnvironmentId): void {
  if (live !== null) return;
  const token = ++nextToken;
  const session: LiveSession = {
    token,
    environmentId,
    sessionId: null,
    microphone: null,
    peer: null,
    audio: null,
    meter: null,
    releases: [],
  };
  live = session;
  dispatch({ type: "start", environmentId });
  listenForUnload();
  void connect(session);
}

async function connect(session: LiveSession): Promise<void> {
  const { token, environmentId } = session;
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    end(token, INSECURE_ORIGIN_MESSAGE);
    return;
  }
  // Created before the first await, while the click that started the session still counts.
  const context = new AudioContext();
  void context.resume().catch(() => undefined);
  session.meter = startLevelMeter(context, () => {
    const { phase, muted } = useChiefOfStaffStore.getState();
    return phase === "speaking" ? "remote" : phase === "listening" && !muted ? "microphone" : null;
  });
  session.releases.push(watchEnvironment(session));

  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true }).then(
    (stream) => stream,
    (error: unknown) => {
      end(token, microphoneErrorMessage(error));
      return null;
    },
  );
  if (microphone === null) return;
  if (!isCurrent(token)) {
    for (const track of microphone.getTracks()) track.stop();
    return;
  }
  session.microphone = microphone;
  const { muted } = useChiefOfStaffStore.getState();
  for (const track of microphone.getAudioTracks()) track.enabled = !muted;
  session.meter.listenTo("microphone", microphone);

  const peer = new RTCPeerConnection();
  session.peer = peer;
  const audio = new Audio();
  audio.autoplay = true;
  session.audio = audio;
  for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
  peer.addEventListener("track", (event) => {
    const [remote] = event.streams;
    if (remote === undefined || !isCurrent(token)) return;
    audio.srcObject = remote;
    void audio.play().catch(() => undefined);
    session.meter?.listenTo("remote", remote);
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") end(token, PEER_FAILED_MESSAGE);
  });
  // The provider expects this channel in the offer even though transcripts come from the server.
  peer.createDataChannel("oai-events");

  const offer = await peer
    .createOffer()
    .then((description) => peer.setLocalDescription(description))
    .then(() => waitForIceGathering(peer))
    .then(
      () => peer.localDescription?.sdp ?? null,
      () => null,
    );
  if (!isCurrent(token)) return;
  if (offer === null) {
    end(token, "Could not set up the voice connection in this browser.");
    return;
  }

  const started = await runAtomCommand(
    appAtomRegistry,
    chiefOfStaffCommands.start,
    { environmentId, input: { sdpOffer: offer } },
    { reportFailure: false },
  );
  if (started._tag === "Failure") {
    if (!isAtomCommandInterrupted(started)) {
      end(token, failureMessage(started, "Could not start Chief of staff."));
    }
    return;
  }
  const { sessionId, sdpAnswer } = started.value;
  if (!isCurrent(token)) {
    // Stopped while the server was starting it.
    sendStop(environmentId, sessionId);
    return;
  }
  session.sessionId = sessionId;
  dispatch({ type: "started", sessionId });
  session.releases.push(followEvents(session, sessionId));

  const answered = await peer.setRemoteDescription({ type: "answer", sdp: sdpAnswer }).then(
    () => true,
    () => false,
  );
  if (!answered) end(token, "Could not connect the voice session.");
}

export function stopChiefOfStaff(): void {
  if (live !== null) end(live.token, null);
}

export function setChiefOfStaffMuted(muted: boolean): void {
  if (live === null || !isChiefOfStaffLive(useChiefOfStaffStore.getState().phase)) return;
  for (const track of live.microphone?.getAudioTracks() ?? []) track.enabled = !muted;
  dispatch({ type: "muted", muted });
}
