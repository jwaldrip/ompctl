#!/usr/bin/env bun
/**
 * Prove the one leg scripts/check-voice-loop.ts has to leave UNPROVEN: that a
 * spoken sentence, captured as audio, becomes a turn in a REAL agent's
 * transcript on this machine's already-running daemon.
 *
 * The sibling stops at a synthetic agent id because its next step would spawn
 * an agent and bill a model turn. This script spends exactly one, deliberately,
 * and keeps everything else cheap: the session lives in a scratch directory
 * under the daemon's filesystem root, the spoken sentence asks for a one-word
 * answer so the turn terminates immediately, and the session is stopped and
 * the directory removed afterwards.
 *
 * Eight stages, each independently falsifiable:
 *
 *   1. daemon    the running daemon authenticates the local operator token
 *   2. session   session_create over the socket answers a real agentId
 *   3. speech    a known sentence is synthesised to wire-rate PCM
 *   4. heard     the daemon's own ASR transcribes the streamed audio
 *   5. turn      the agent's stored transcript holds the spoken user turn
 *   6. audit     the daemon's audit log holds agent.prompt ok for that agent
 *   7. settled   the turn finished, so the model spend is the one planned
 *   8. cleanup   the session is stopped and the scratch directory removed
 *
 * The evidence surfaces are the daemon's, never this script's echo. Stage 5
 * reads the session file through the daemon's session_tail frame and stage 6
 * reads the audit table through GET /v1/audit. The transcript frame the socket
 * also returns is printed as a diagnostic: it proves frame routing, not that
 * a turn happened.
 *
 * The daemon is whatever is already listening on the port; nothing here
 * starts or configures one. If the handoff is refused, the daemon's own error
 * frame is the reported reason, not a guess.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerFrame, TranscriptTailMessage } from "@ompd/core";
import {
  type PcmAudio,
  pcmToBase64,
  selectTtsEngine,
  speakableSegments,
  type TtsEngine,
} from "../packages/daemon/src/voice/index.ts";

/**
 * Distinctive, short, and terminating: one unusual content word no
 * hallucination lands on by accident, few enough words to keep the turn
 * trivial, and an instruction whose complete answer is a single word.
 */
const DEFAULT_SENTENCE = "Reply with the single word porcupine.";

/** The wire format the bridge and OMP's ASR worker both expect. */
const WIRE_RATE = 16_000;

/**
 * Trailing quiet appended to the utterance, so the endpointer's 700ms
 * hangover settles without the script having to force audio_end.
 */
const TRAILING_SILENCE_MS = 1_200;

/** 100ms packets, which is what a MediaRecorder timeslice looks like. */
const PACKET_MS = 100;

/** Word error rate ceiling for "reasonably matching", as in the sibling. */
const MAX_WORD_ERROR_RATE = 0.34;

/** Spawning the agent behind session_create can take a while. */
const SESSION_TIMEOUT_MS = 120_000;

/** The daemon's ASR over a few seconds of audio, as in the sibling. */
const TRANSCRIPT_TIMEOUT_MS = 180_000;

/** A turn plus its flush to the session file; generous because it is real. */
const TURN_TIMEOUT_MS = 240_000;

/** How often session_tail is re-asked while waiting for the turn to land. */
const POLL_INTERVAL_MS = 2_000;

type Status = "PASS" | "FAIL" | "UNPROVEN";

interface StageResult {
  name: string;
  status: Status;
  detail: string;
}

const results: StageResult[] = [];
let failed = false;

function heading(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function record(name: string, ok: boolean, detail: string): void {
  const status: Status = ok ? "PASS" : "FAIL";
  results.push({ name, status, detail });
  if (!ok) failed = true;
  console.log(`\n[${status}] ${name}: ${detail}`);
}

function unproven(name: string, detail: string): void {
  results.push({ name, status: "UNPROVEN", detail });
  console.log(`\n[UNPROVEN] ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// audio helpers, shared verbatim in spirit with the sibling
// ---------------------------------------------------------------------------

function resamplePcm16(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const ratio = from / to;
  const length = Math.floor(pcm.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const source = i * ratio;
    const left = Math.floor(source);
    const right = Math.min(left + 1, pcm.length - 1);
    const frac = source - left;
    out[i] = Math.round((pcm[left] ?? 0) * (1 - frac) + (pcm[right] ?? 0) * frac);
  }
  return out;
}

function withTrailingSilence(pcm: Int16Array, rate: number, ms: number): Int16Array {
  const out = new Int16Array(pcm.length + Math.floor((rate * ms) / 1000));
  out.set(pcm, 0);
  return out;
}

async function renderUtterance(engine: TtsEngine, text: string): Promise<PcmAudio & { segments: number }> {
  const chunks: PcmAudio[] = [];
  for await (const chunk of engine.stream(speakableSegments(text))) chunks.push(chunk);
  if (chunks.length === 0) throw new Error(`${engine.name} produced no audio for ${text}`);

  const sampleRate = chunks[0]?.sampleRate ?? WIRE_RATE;
  let total = 0;
  for (const chunk of chunks) total += chunk.pcm.length;
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk.pcm, offset);
    offset += chunk.pcm.length;
  }
  return { pcm, sampleRate, segments: chunks.length };
}

function wordErrorRate(reference: string, hypothesis: string): number {
  const normalise = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 0);

  const ref = normalise(reference);
  const hyp = normalise(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i, ...Array.from({ length: hyp.length }, () => 0)];
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return (previous[hyp.length] ?? 0) / ref.length;
}

// ---------------------------------------------------------------------------
// one socket to the running daemon
// ---------------------------------------------------------------------------

interface Waiter {
  test: (frame: ServerFrame) => boolean;
  resolve: (frame: ServerFrame) => void;
  describe: string;
}

/**
 * The daemon's socket, with waiters rather than a single done-promise,
 * because this script holds a conversation: open a session, speak, then poll
 * the transcript back over the same wire.
 *
 * Every error frame the daemon sends is kept, in order, whether or not a
 * waiter was looking for it: a refusal like voice_prompt_failed is the
 * finding this script exists to surface, so it must survive even when it
 * arrives while nobody is waiting on an error.
 */
class DaemonSocket {
  readonly errors: string[] = [];
  said: string[] = [];
  speechPackets = 0;
  #socket: WebSocket;
  #waiters: Waiter[] = [];

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      if (frame.t === "error") this.errors.push(`${frame.code ?? "error"}: ${frame.message}`);
      if (frame.t === "say") this.said.push(frame.text.slice(0, 80));
      if (frame.t === "speech") this.speechPackets += 1;
      for (const waiter of [...this.#waiters]) {
        if (waiter.test(frame)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  /**
   * The hello frame, which is itself proof the upgrade succeeded: it is the
   * first thing the daemon sends, so waiting for it covers both the socket
   * opening and the daemon's greeting. The waiter is registered before the
   * socket can have delivered anything, so a fast daemon cannot race it.
   */
  opened(): Promise<ServerFrame> {
    const { promise, resolve, reject } = Promise.withResolvers<ServerFrame>();
    this.#waiters.push({
      test: frame => frame.t === "hello",
      resolve,
      describe: "the hello frame",
    });
    setTimeout(() => {
      this.#remove(resolve);
      reject(new Error("no hello frame within 10s"));
    }, 10_000);
    this.#socket.addEventListener("error", () => reject(new Error("socket failed to open")));
    return promise;
  }

  #remove(resolve: (frame: ServerFrame) => void): void {
    const index = this.#waiters.findIndex(waiter => waiter.resolve === resolve);
    if (index >= 0) this.#waiters.splice(index, 1);
  }

  /** Resolve with the next frame matching `test`, or reject on timeout. */
  next(test: (frame: ServerFrame) => boolean, describe: string, timeoutMs: number): Promise<ServerFrame> {
    const { promise, resolve, reject } = Promise.withResolvers<ServerFrame>();
    this.#waiters.push({ test, resolve, describe });
    setTimeout(() => {
      this.#remove(resolve);
      reject(new Error(`no ${describe} within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    return promise;
  }

  send(frame: unknown): void {
    this.#socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.#socket.close();
  }
}

/** One session_tail poll: the tail, or "unknown" while the file does not exist yet. */
async function readTail(socket: DaemonSocket, sessionId: string): Promise<TranscriptTailMessage[] | null> {
  socket.send({ t: "session_tail", sessionId, limit: 20 });
  const frame = await socket.next(
    candidate => (candidate.t === "session_tail" && candidate.sessionId === sessionId) || candidate.t === "error",
    "session_tail answer",
    30_000,
  );
  if (frame.t === "session_tail") return frame.messages;
  // unknown_session is the daemon saying the session file is not on disk yet,
  // which is the normal state between session_opened and the first turn.
  if (frame.t === "error" && frame.code === "unknown_session") return null;
  if (frame.t === "error") throw new Error(`session_tail refused: ${frame.code}: ${frame.message}`);
  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const sentence = flag("sentence") ?? DEFAULT_SENTENCE;
const port = Number(flag("port") ?? "7777");
const token = (flag("token") ?? `${homedir()}/.ompd/token`).replace(/^~/, homedir());
const root = flag("root") ?? homedir();

console.log(`ompd voice live handoff check
sentence: ${JSON.stringify(sentence)}
daemon:   http://127.0.0.1:${port} (already running, not started by this script)
root:     ${root}`);

let scratch: string | null = null;
let agentId: string | null = null;
let socket: DaemonSocket | null = null;
let stopped = false;

try {
  // -- stage 1 --------------------------------------------------------------
  heading("stage 1: daemon");
  const tokenValue = (await Bun.file(token).text()).trim();
  const status = await fetch(`http://127.0.0.1:${port}/v1/status`, {
    headers: { authorization: `Bearer ${tokenValue}` },
  });
  const statusBody = (await status.json().catch(() => ({}))) as Record<string, unknown>;
  console.log(`GET /v1/status: ${status.status} ${JSON.stringify(statusBody)}`);
  record(
    "the running daemon authenticates the local operator token",
    status.status === 200,
    `http ${status.status} from Bearer ${token}`,
  );
  if (status.status !== 200) {
    throw new Error(`the daemon on port ${port} did not accept the operator token; nothing else can run`);
  }

  // -- stage 2 --------------------------------------------------------------
  heading("stage 2: session, over the daemon's socket");
  scratch = mkdtempSync(join(root, ".ompd-voice-live-handoff-"));
  console.log(`scratch:  ${scratch}`);
  socket = new DaemonSocket(`ws://127.0.0.1:${port}/v1/socket?token=${tokenValue}`);
  const hello = await socket.opened();
  if (hello.t !== "hello") throw new Error("unreachable");
  console.log(`hello:    device ${hello.deviceId}, ${hello.agents.length} agent(s) already known to it`);

  socket.send({ t: "session_create", cwd: scratch, name: "voice live handoff check" });
  const opened = await socket.next(
    frame => frame.t === "session_opened" || frame.t === "error",
    "session_opened",
    SESSION_TIMEOUT_MS,
  );
  if (opened.t === "error") {
    throw new Error(`session_create refused: ${opened.code}: ${opened.message}`);
  }
  if (opened.t !== "session_opened") throw new Error("unreachable");
  agentId = opened.agentId;
  const sessionId = opened.sessionId;
  console.log(`agentId:  ${agentId}`);
  console.log(`session:  ${sessionId}`);
  record(
    "the daemon created a real session for this run",
    agentId.length > 0 && sessionId.length > 0,
    `${agentId} at ${scratch} over ws://127.0.0.1:${port}/v1/socket`,
  );

  // -- stage 3 --------------------------------------------------------------
  heading("stage 3: speech");
  const selectionLog: string[] = [];
  const tts = await selectTtsEngine({ onLog: line => selectionLog.push(line) });
  for (const line of selectionLog) console.log(line);
  const spoken = await renderUtterance(tts, sentence);
  const wire = resamplePcm16(spoken.pcm, spoken.sampleRate, WIRE_RATE);
  const utterance = withTrailingSilence(wire, WIRE_RATE, TRAILING_SILENCE_MS);
  console.log(`engine:      ${tts.name}`);
  console.log(`segments:    ${spoken.segments}`);
  console.log(
    `utterance:   ${(utterance.length / WIRE_RATE).toFixed(2)}s including ${TRAILING_SILENCE_MS}ms of trailing silence`,
  );
  record(
    "tts produced real audio",
    spoken.pcm.length > WIRE_RATE / 4,
    `${(spoken.pcm.length / spoken.sampleRate).toFixed(2)}s from ${tts.name} in ${spoken.segments} segment(s)`,
  );

  // -- stage 4 --------------------------------------------------------------
  heading("stage 4: heard, over the daemon's own ASR");
  const packet = (WIRE_RATE * PACKET_MS) / 1000;
  for (let offset = 0; offset < utterance.length; offset += packet) {
    socket.send({
      t: "audio",
      agentId,
      pcm: pcmToBase64(utterance.subarray(offset, offset + packet)),
    });
  }
  socket.send({ t: "audio_end", agentId });
  const heard = await socket.next(
    frame => frame.t === "transcript" || frame.t === "error",
    "transcript frame",
    TRANSCRIPT_TIMEOUT_MS,
  );
  if (heard.t === "error") {
    // The refusal itself is reported below as the stage 5 failure reason; the
    // throw keeps stages 5 to 7 from waiting on a turn that cannot start.
    throw new Error(`the daemon refused the audio: ${heard.code}: ${heard.message}`);
  }
  if (heard.t !== "transcript") throw new Error("unreachable");
  const heardWer = wordErrorRate(sentence, heard.text);
  console.log(`daemon heard: ${JSON.stringify(heard.text)}`);
  console.log(`word error rate against the spoken sentence: ${heardWer.toFixed(3)}`);
  record(
    "the daemon heard the streamed audio",
    heardWer <= MAX_WORD_ERROR_RATE,
    `wer ${heardWer.toFixed(3)} over the daemon's own ASR (routing only, not the handoff)`,
  );

  // -- stage 5 --------------------------------------------------------------
  heading("stage 5: the turn, read from the agent's own transcript");
  let stored: TranscriptTailMessage | null = null;
  let unknownSessionPolls = 0;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const refusal = socket.errors.find(line => line.startsWith("voice_prompt_failed"));
    if (refusal !== undefined) {
      console.log(`daemon error frame: ${refusal}`);
      record(
        "the spoken sentence became a stored user turn",
        false,
        `the daemon logged ${refusal}; onTranscript rejected the handoff before a turn started`,
      );
      break;
    }
    const messages = await readTail(socket, sessionId);
    if (messages === null) {
      unknownSessionPolls += 1;
    } else {
      const userTurns = messages.filter(message => message.role === "user");
      const last = userTurns.at(-1);
      if (last !== undefined) {
        stored = last;
        break;
      }
    }
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, POLL_INTERVAL_MS);
    await pause.promise;
  }
  if (stored !== null) {
    const storedWer = wordErrorRate(sentence, stored.text);
    console.log(`surface:     session_tail frame, read from the session file by the daemon`);
    console.log(`stored turn: ${JSON.stringify(stored.text)}`);
    console.log(`word error rate against the spoken sentence: ${storedWer.toFixed(3)}`);
    record(
      "the spoken sentence became a stored user turn",
      storedWer <= MAX_WORD_ERROR_RATE,
      `wer ${storedWer.toFixed(3)} via the daemon's session_tail frame for ${sessionId}`,
    );
  } else if (!socket.errors.some(line => line.startsWith("voice_prompt_failed"))) {
    record(
      "the spoken sentence became a stored user turn",
      false,
      `no user turn in the session file within ${TURN_TIMEOUT_MS / 1000}s (${unknownSessionPolls} polls returned unknown_session)`,
    );
  }

  // -- stage 6 --------------------------------------------------------------
  heading("stage 6: the audit row, through the daemon's HTTP surface");
  const auditResponse = await fetch(`http://127.0.0.1:${port}/v1/audit?limit=100`, {
    headers: { authorization: `Bearer ${tokenValue}` },
  });
  const auditBody = (await auditResponse.json()) as { entries?: Array<Record<string, unknown>> };
  const row = (auditBody.entries ?? []).find(entry => entry.action === "agent.prompt" && entry.agentId === agentId);
  console.log(`GET /v1/audit?limit=100: ${auditResponse.status}`);
  console.log(`row: ${JSON.stringify(row)}`);
  const charsMatch =
    row !== undefined &&
    stored !== null &&
    typeof row.detail === "object" &&
    row.detail !== null &&
    (row.detail as Record<string, unknown>).chars === stored.text.length;
  record(
    "the daemon's audit holds the prompt action with an ok outcome",
    row !== undefined && row.outcome === "ok" && charsMatch,
    row === undefined
      ? `no agent.prompt row for ${agentId} in the last ${auditBody.entries?.length ?? 0} entries`
      : `id ${row.id} ${row.action} ${row.outcome}, detail.chars ${JSON.stringify((row.detail as Record<string, unknown>).chars)} vs stored turn length ${stored?.text.length ?? "?"}`,
  );

  // -- stage 7 --------------------------------------------------------------
  heading("stage 7: the turn settled");
  let assistant: TranscriptTailMessage | null = null;
  const settleDeadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < settleDeadline) {
    const messages = await readTail(socket, sessionId);
    const lastAssistant = messages?.filter(message => message.role === "assistant").at(-1);
    if (lastAssistant !== undefined) {
      assistant = lastAssistant;
      break;
    }
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, POLL_INTERVAL_MS);
    await pause.promise;
  }
  if (assistant !== null) {
    console.log(`assistant: ${JSON.stringify(assistant.text.slice(0, 200))}`);
    record(
      "the turn finished",
      true,
      `the session file holds the assistant turn ending it${socket.said.length > 0 ? `, and a say frame carried "${socket.said[0]}"` : ""}`,
    );
  } else {
    record("the turn finished", false, `no assistant turn in the session file within ${TURN_TIMEOUT_MS / 1000}s`);
  }
  if (socket.said.length === 0 && socket.speechPackets === 0) {
    unproven(
      "the daemon spoke the reply back",
      "out of scope by design: this check proves speech becoming a turn, and the socket received no say or speech frame while it stayed open through the turn",
    );
  }
} catch (err) {
  failed = true;
  console.error(`\nfatal: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  // -- stage 8 --------------------------------------------------------------
  heading("stage 8: cleanup");
  const removed: string[] = [];
  if (socket !== null) {
    socket.close();
    console.log("socket: closed");
  }
  if (agentId !== null) {
    try {
      const tokenValue = (await Bun.file(token).text()).trim();
      const stop = await fetch(`http://127.0.0.1:${port}/v1/agents/${agentId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenValue}` },
      });
      stopped = stop.status === 200;
      console.log(`DELETE /v1/agents/${agentId}: ${stop.status}`);
      if (stopped) removed.push(`agent ${agentId} (stopped, agent.stop audited)`);
    } catch (err) {
      console.error(`stopping the agent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (scratch !== null) {
    rmSync(scratch, { recursive: true, force: true });
    const gone = !existsSync(scratch);
    console.log(`removed ${scratch}: ${gone}`);
    if (gone) removed.push(scratch);
  }
  const leftovers: string[] = [];
  if (agentId !== null && !stopped) leftovers.push(`agent ${agentId} still registered`);
  if (scratch !== null && existsSync(scratch)) leftovers.push(`${scratch} still on disk`);
  record(
    "the run left nothing behind it created",
    leftovers.length === 0,
    leftovers.length === 0 ? `removed: ${removed.join("; ")}` : leftovers.join("; "),
  );
  console.log(
    `kept, deliberately: the daemon's audit rows and the session file for this run are its own durable record`,
  );
}

heading("summary");
for (const result of results) {
  console.log(`${result.status.padEnd(9)} ${result.name} -- ${result.detail}`);
}
const unprovenLegs = results.filter(result => result.status === "UNPROVEN");
if (failed) {
  console.log("\nVOICE LIVE HANDOFF NOT PROVEN");
} else if (unprovenLegs.length > 0) {
  console.log("\nVOICE LIVE HANDOFF PROVEN; these legs were not exercised:");
  for (const leg of unprovenLegs) console.log(`  - ${leg.name}: ${leg.detail}`);
} else {
  console.log("\nVOICE LIVE HANDOFF PROVEN");
}
process.exit(failed ? 1 : 0);
