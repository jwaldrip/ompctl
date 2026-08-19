/**
 * The speech-worker half of a compiled ompd.
 *
 * OMP's speech clients, the `SttClient` and `TtsClient` a daemon loads in
 * process, do not run inference themselves: they re-execute the running
 * executable with a hidden `__omp_worker_*` selector and speak process IPC to
 * the child, so `onnxruntime-node` never loads in the daemon's address space
 * (its NAPI finalizer segfaults Bun on shutdown). In an installed daemon the
 * executable `resolveWorkerSpawnCmd` picks is `process.execPath`, which is
 * this binary. omp's own CLI dispatches those selectors; ompd never did, so a
 * compiled daemon spawned `ompd __omp_worker_stt`, read the usage banner and
 * exit 2 back as the worker's stderr, and every installed daemon was deaf and
 * mute while a source-run daemon worked, because from source the spawn falls
 * back to omp's own cli.ts entry.
 *
 * This module is the dispatch that spawn is owed. It hosts the two workers
 * the daemon's voice stack launches, over the same process-IPC bridge omp's
 * CLI builds for them. The other `__omp_worker_*` selectors are deliberately
 * not hosted: nothing in this binary spawns them, and a selector this binary
 * cannot serve should fail loudly at the spawn rather than half-answer it.
 *
 * Reached only through the selector branch in `main.ts`, which imports this
 * module dynamically, so a plain `ompd status` pays nothing and the speech
 * runtimes load in exactly one place: a worker subprocess.
 */

/** The selectors this binary hosts, listed rather than prefix-matched. */
const HOSTED_SELECTORS = ["__omp_worker_stt", "__omp_worker_tts"] as const;

export type WorkerSelector = (typeof HOSTED_SELECTORS)[number];

/** True when `selector` names a speech worker this binary serves. */
export function isHostedWorkerSelector(selector: string | undefined): selector is WorkerSelector {
  return selector !== undefined && (HOSTED_SELECTORS as readonly string[]).includes(selector);
}

/**
 * The process-IPC surface a hosted worker's typed transport binds to. A superset
 * of both `SttTransport` and `TtsTransport`, so one bridge serves either.
 */
interface WorkerIpcTransport<In, Out> {
  send(message: Out): void;
  sendAndFlush(message: Out): Promise<void>;
  onMessage(handler: (message: In) => void): () => void;
}

/**
 * Bridge the parent's process IPC to a worker's transport and block until the
 * parent goes away.
 *
 * Mirrors the private `runIpcSubprocessWorker` in omp's cli.ts, which cannot
 * be imported (it is not exported) and must not drift from casually: the
 * keepalive holds the loop open while the worker idles with its model loaded,
 * and shutdown hard-kills this process with SIGKILL so the onnxruntime NAPI
 * finalizer never runs here either. A send that fails means the channel is
 * gone; the worker treats that as shutdown rather than throwing into its
 * message pump.
 */
async function serve<In, Out>(start: (transport: WorkerIpcTransport<In, Out>) => void): Promise<never> {
  const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();

  const send = (message: Out): void => {
    if (process.send === undefined) {
      shutdown();
      return;
    }
    try {
      process.send(message);
    } catch {
      shutdown();
    }
  };

  const sendAndFlush = (message: Out): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (process.send === undefined) {
      shutdown();
      return Promise.resolve();
    }
    try {
      process.send(message, () => resolve());
    } catch {
      shutdown();
      resolve();
    }
    return promise;
  };

  start({
    send,
    sendAndFlush,
    onMessage(handler) {
      const wrap = (data: unknown): void => handler(data as In);
      process.on("message", wrap);
      return () => {
        process.off("message", wrap);
      };
    },
  });

  const keepalive = setInterval(() => {}, 2 ** 30);
  process.on("disconnect", () => shutdown());
  try {
    await shuttingDown;
  } finally {
    clearInterval(keepalive);
  }
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable: the worker was SIGKILLed before this line");
}

/**
 * Run the worker a selector names, for the rest of this process's life. The
 * imports are dynamic so bundling the CLI pulls each speech stack in only as
 * its own chunk, and so a hosted stt worker never even parses the tts code.
 * Static imports cannot work here: they would load onnxruntime and the model
 * runtimes into every `ompd status`.
 */
export async function runHostedWorker(selector: WorkerSelector): Promise<never> {
  if (selector === "__omp_worker_stt") {
    const { startSttWorker } = await import("@oh-my-pi/pi-coding-agent/stt/asr-worker");
    return serve(startSttWorker);
  }
  const { startTtsWorker } = await import("@oh-my-pi/pi-coding-agent/tts/tts-worker");
  return serve(startTtsWorker);
}
