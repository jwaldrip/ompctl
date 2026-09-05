/**
 * Live proof script for OMP co-drive collab and steer against a real omp TUI.
 *
 * Exercises:
 * 1. Spawns scratch daemon on 127.0.0.1.
 * 2. Spawns real omp in a scratch git directory with ompd bridge extension loaded.
 * 3. Proves STEER: injects session_prompt and asserts tui_activity + PTY output.
 * 4. Proves COLLAB: starts room via /collab, captures link, calls collab_open { sessionId, link },
 *    attaches, verifies back-transcript, sends second prompt through guest leg, verifies reply update.
 * 5. Clean teardown and prints COLLAB LIVE GREEN.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Subprocess } from "bun";

const repoRoot = join(import.meta.dir, "..");
const extensionPath = join(repoRoot, "packages", "omp-extension", "src", "index.ts");
const cliPath = join(repoRoot, "packages", "cli", "src", "main.ts");

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not obtain free port")));
      }
    });
  });
}

async function waitUntil<T>(probe: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await probe();
    if (res !== undefined) return res;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const scratchHome = mkdtempSync(join(tmpdir(), "ompd-live-home-"));
  const scratchCwd = mkdtempSync("/private/tmp/omp-live-cwd-");
  const port = await getFreePort();

  let daemonProc: Subprocess | null = null;
  let ompProc: Subprocess | null = null;
  let clientWs: WebSocket | null = null;
  let ptyOutput = "";
  let daemonLogs = "";
  const incomingFrames: any[] = [];

  const cleanup = async () => {
    try {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    } catch {}
    try {
      if (ompProc) {
        ompProc.kill("SIGTERM");
      }
    } catch {}
    try {
      if (daemonProc) {
        daemonProc.kill("SIGTERM");
      }
    } catch {}
    try {
      rmSync(scratchHome, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(scratchCwd, { recursive: true, force: true });
    } catch {}
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(1));
  });

  try {
    // 1. Initialize scratch git repo for omp
    const gitInit = Bun.spawn(["git", "init"], { cwd: scratchCwd, stdout: "ignore", stderr: "ignore" });
    await gitInit.exited;

    // 2. Start scratch daemon
    daemonProc = Bun.spawn([process.execPath, cliPath, "start", "--host", "127.0.0.1", "--port", String(port), "--foreground"], {
      env: { ...process.env, OMPD_HOME: scratchHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    (async () => {
      const dec = new TextDecoder();
      if (daemonProc?.stdout) for await (const chunk of daemonProc.stdout as any) daemonLogs += dec.decode(chunk);
    })();
    (async () => {
      const dec = new TextDecoder();
      if (daemonProc?.stderr) for await (const chunk of daemonProc.stderr as any) daemonLogs += dec.decode(chunk);
    })();

    // Wait for daemon health
    const tokenPath = join(scratchHome, "token");
    let token = "";
    await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
        if (res.status === 200) {
          token = readFileSync(tokenPath, "utf8").trim();
          return token.length > 0 ? token : undefined;
        }
      } catch {}
      return undefined;
    }, "daemon to start and write token", 20_000);

    console.log(`PHASE: DAEMON STARTED on 127.0.0.1:${port}`);

    // 3. Spawn real omp TUI with exactly one bridge. `ompd install` puts a
    // copy of this extension under the operator's own agent directory, and
    // omp discovers that copy on top of the `-e` one; two bridges register
    // the same session twice and every steer lands as two turns. Discovery
    // is off so the proof drives the bridge in this tree and nothing else.
    const decoder = new TextDecoder();
    const bridgeLogPath = join(scratchHome, "bridge.log");
    ompProc = Bun.spawn(["/opt/homebrew/bin/omp", "--no-extensions", "-e", extensionPath], {
      cwd: scratchCwd,
      env: { ...process.env, OMPD_HOME: scratchHome, OMPD_BRIDGE_DEBUG: bridgeLogPath, TERM: "xterm-256color" },
      terminal: {
        cols: 120,
        rows: 40,
        data(_term, bytes) {
          ptyOutput += decoder.decode(bytes);
        },
      },
    });

    // 4. Wait for session to register with daemon
    let sessionId = "";
    await waitUntil(async () => {
      try {
        if (existsSync(bridgeLogPath)) {
          const log = readFileSync(bridgeLogPath, "utf8");
          const match = log.match(/"registered","sessionId":"([^"]+)"/);
          if (match) {
            sessionId = match[1];
            return sessionId;
          }
        }
      } catch {}
      return undefined;
    }, "omp TUI session registration in daemon", 30_000);

    console.log(`PHASE: TUI REGISTERED session=${sessionId}`);

    // 5. Connect client websocket and arm activity forwarding
    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`;
    clientWs = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      clientWs!.onopen = () => resolve();
      clientWs!.onerror = err => reject(err);
    });

    clientWs.onmessage = event => {
      try {
        const parsed = JSON.parse(String(event.data));
        incomingFrames.push(parsed);
      } catch {}
    };

    // Arm activity forwarding by listing sessions
    clientWs.send(JSON.stringify({ t: "sessions" }));
    await Bun.sleep(1000);

    // 6. Proves STEER
    const nonce1 = `steer_${Date.now().toString(36)}`;
    const steerPromptText = `Reply with exactly: ${nonce1}`;
    clientWs.send(JSON.stringify({ t: "session_prompt", sessionId, text: steerPromptText }));

    // The steer is proven only by the terminal's model answering: an
    // `assistant_text` activity carrying the nonce. The PTY echoes the prompt
    // itself as the user turn, so "the nonce appeared on screen" would pass
    // before any model ran; that is not evidence of a reply.
    await waitUntil(() => {
      const act = incomingFrames.find(
        f =>
          f.t === "tui_activity" &&
          f.sessionId === sessionId &&
          f.kind === "assistant_text" &&
          typeof f.text === "string" &&
          f.text.includes(nonce1),
      );
      return act ? true : undefined;
    }, "assistant_text activity carrying the steer nonce", 90_000);

    console.log(`PHASE: STEER PROVEN nonce=${nonce1}`);

    // 7. Proves COLLAB
    // Request /collab in PTY
    ompProc?.terminal?.write(`/collab ws://127.0.0.1:${port}\r`);

    // Capture collab link from PTY bytes
    let collabLink = "";
    await waitUntil(() => {
      const clean = stripAnsi(ptyOutput);
      // Link matches ws://127.0.0.1:<port>/r/<roomId>.<key> or similar
      const match = clean.match(/ws:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_.-]+/);
      if (match) {
        collabLink = match[0];
        return collabLink;
      }
      // Also check if link was printed as bare room.key
      const bareMatch = clean.match(/([A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{43,})/);
      if (bareMatch) {
        collabLink = `ws://127.0.0.1:${port}/r/${bareMatch[1]}`;
        return collabLink;
      }
      return undefined;
    }, "collab link to appear in PTY output", 30_000);

    // The link is a credential: print the room, never the key after the dot.
    console.log(`PHASE: COLLAB LINK CAPTURED room=${collabLink.replace(/^.*\/r\//, "").replace(/\..*$/, "")}`);

    // Send collab_open
    clientWs.send(JSON.stringify({ t: "collab_open", sessionId, link: collabLink }));

    // Wait for collab_opened frame
    const collabOpened = await waitUntil(() => {
      return incomingFrames.find(f => f.t === "collab_opened" && f.sessionId === sessionId);
    }, "collab_opened frame", 20_000);

    const agentId = collabOpened.agentId;
    console.log(`PHASE: COLLAB OPENED agentId=${agentId}`);

    // Attach to guest leg with sinceSeq: 0
    clientWs.send(JSON.stringify({ t: "attach", agentId, sinceSeq: 0 }));

    // The back-transcript must carry the steered turn as the operator's own
    // user entry, which is what a guest joining late is owed.
    await waitUntil(() => {
      return incomingFrames.find(
        f =>
          f.t === "update" &&
          f.agentId === agentId &&
          f.update?.sessionUpdate === "user_message_chunk" &&
          JSON.stringify(f.update).includes(nonce1),
      );
    }, "back-transcript user entry containing nonce1", 20_000);

    console.log(`PHASE: BACK-TRANSCRIPT VERIFIED`);

    // Send prompt with second nonce through guest leg
    const nonce2 = `collab_${Date.now().toString(36)}`;
    clientWs.send(JSON.stringify({ t: "prompt", agentId, text: `Reply with exactly: ${nonce2}` }));

    // Only the model's answer counts. The guest leg also maps the prompt's
    // own echo to a user entry carrying nonce2, which is not a reply.
    await waitUntil(() => {
      const textByMsg = new Map<string, string>();
      for (const f of incomingFrames) {
        if (f.t === "update" && f.agentId === agentId && f.update?.sessionUpdate === "agent_message_chunk") {
          const mid = (f.update as { messageId?: string }).messageId ?? "";
          const chunkText = (f.update as { content?: { text?: string } }).content?.text ?? "";
          textByMsg.set(mid, (textByMsg.get(mid) ?? "") + chunkText);
        }
      }
      for (const fullText of textByMsg.values()) {
        if (fullText.includes(nonce2)) return true;
      }
      return undefined;
    }, "assistant reply text containing nonce2", 90_000);

    console.log(`PHASE: COLLAB PROMPT PROVEN nonce=${nonce2}`);

    // 8. Leave collab
    clientWs.send(JSON.stringify({ t: "collab_leave", sessionId }));
    ompProc?.terminal?.write("/collab stop\r");
    await Bun.sleep(1000);

    console.log("PHASE: TEARDOWN");
    await cleanup();
    console.log("COLLAB LIVE GREEN");
    process.exit(0);
  } catch (err) {
    console.error("FAILED PHASE:", err instanceof Error ? err.message : String(err));
    console.error("INCOMING FRAMES:", JSON.stringify(incomingFrames, null, 2));
    if (daemonLogs.length > 0) {
      console.error("DAEMON LOG (last 1000 chars):");
      console.error(daemonLogs.slice(-1000));
    }
    try {
      const bridgeLog = readFileSync(join(scratchHome, "bridge.log"), "utf8");
      console.error("BRIDGE LOG:\n", bridgeLog);
    } catch {}
    if (ptyOutput.length > 0) {
      console.error("PTY OUTPUT (last 1000 chars):");
      console.error(stripAnsi(ptyOutput).slice(-1000));
    }
    await cleanup();
    process.exit(1);
  }
}

void main();
