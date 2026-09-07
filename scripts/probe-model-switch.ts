/**
 * Probe ACP session configuration and model switching against the real `omp acp` binary.
 *
 * Spawns `omp acp` over stdio, creates a new session, inspects advertised `configOptions`,
 * sets the `model` option to another valid choice from the advertised list via
 * `session/set_config_option`, and verifies the updated value is read back.
 *
 * Usage: bun run scripts/probe-model-switch.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface ProbeConfigChoice {
  value: string;
  name: string;
}

interface ProbeConfigOption {
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: ProbeConfigChoice[];
}

interface InitializeResult {
  agentInfo?: {
    name: string;
    version: string;
  };
}

interface NewSessionResult {
  sessionId: string;
  configOptions?: ProbeConfigOption[];
}

interface SetConfigOptionResult {
  configOptions?: Array<{
    id: string;
    currentValue: string;
  }>;
}

const workdir = mkdtempSync(join(tmpdir(), "omp-model-switch-probe-"));

try {
  const proc = Bun.spawn(["omp", "acp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: workdir,
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readLine(): Promise<JsonRpcMessage> {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) {
          return JSON.parse(line) as JsonRpcMessage;
        }
      }
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("EOF from omp acp");
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  function send(msg: unknown): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    void proc.stdin.flush();
  }

  // 1. Initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
    },
  });

  let initResp = await readLine();
  while (initResp.method !== undefined) {
    initResp = await readLine();
  }

  const initResult: InitializeResult = (initResp.result ?? {}) as InitializeResult;
  const agentInfo = initResult.agentInfo;
  console.log(`Connected to ACP agent: ${agentInfo?.name ?? "unknown"} ${agentInfo?.version ?? ""}`);

  // 2. session/new
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: workdir, mcpServers: [] },
  });

  let newResp = await readLine();
  while (newResp.method !== undefined) {
    newResp = await readLine();
  }

  const newResult: NewSessionResult = (newResp.result ?? { sessionId: "" }) as NewSessionResult;
  const sessionId = newResult.sessionId;
  const configOptions = newResult.configOptions ?? [];

  console.log(`Created ACP session: ${sessionId}`);
  console.log(`Advertised config options (${configOptions.length}):`);
  for (const opt of configOptions) {
    console.log(
      `  - [${opt.id}] "${opt.name}" (category: ${opt.category}): currentValue = "${opt.currentValue}" (${opt.options.length} choices)`,
    );
  }

  // 3. Select model option and find an alternate choice
  const modelOption = configOptions.find(opt => opt.id === "model");
  if (!modelOption) {
    throw new Error("No model option advertised in configOptions");
  }

  const currentModel = modelOption.currentValue;
  const targetChoice = modelOption.options.find(c => c.value !== currentModel);
  if (!targetChoice) {
    throw new Error("No alternate model choice available in advertised options");
  }

  console.log(`Current model: "${currentModel}"`);
  console.log(`Switching model to: "${targetChoice.name}" (${targetChoice.value})`);

  // 4. session/set_config_option
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/set_config_option",
    params: {
      sessionId,
      configId: "model",
      value: targetChoice.value,
    },
  });

  let setResp = await readLine();
  const updates: unknown[] = [];
  while (setResp.method !== undefined) {
    if (setResp.method === "session/update") {
      updates.push(setResp.params);
    }
    setResp = await readLine();
  }

  console.log(`Received ${updates.length} session/update notification(s) during switch`);

  const setResult: SetConfigOptionResult = (setResp.result ?? {}) as SetConfigOptionResult;
  const updatedConfig = setResult.configOptions ?? [];
  const updatedModelOption = updatedConfig.find(opt => opt.id === "model");
  const readBackModel = updatedModelOption?.currentValue;
  console.log(`Read back model after switch: "${readBackModel}"`);

  if (readBackModel !== targetChoice.value) {
    throw new Error(`Model mismatch: expected "${targetChoice.value}", got "${readBackModel}"`);
  }

  console.log("Model switch over ACP successfully verified against real binary.");

  proc.kill();
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
