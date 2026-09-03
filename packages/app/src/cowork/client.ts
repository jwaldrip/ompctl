/**
 * The slice of `OmpdClient` the Cowork surface drives.
 *
 * Structural rather than the class itself, so a test can drive the screen with
 * a client of its own and so nothing here can quietly reach for a method that
 * is not part of this feature. `OmpdClient` satisfies it as-is.
 *
 * Every capability here rides the socket, never a daemon HTTP route. A
 * hub-paired phone reaches the daemon through the sealed socket the relay
 * carries; the hub does tunnel one HTTP shape today (the routine webhook
 * POST, as `webhook_request`/`webhook_response`), and Cowork deliberately
 * does not add a second, because a general tunnel would carry this device's
 * bearer token through the hub while typed frames keep the hub relaying
 * opaque sealed traffic. That decision is why this port exists -- it is the
 * whole surface a hub pairing can be promised.
 */

import type { AgentId, WireHostSpec } from "@ompd/core/contracts";
import type {
  AgentCreatedEvent,
  ClientErrorEvent,
  ConnectionState,
  ConnectorsEvent,
  SkillsEvent,
  StatusEvent,
  TaskEvent,
  TasksEvent,
} from "@ompd/core/ompd-client";
import type { NewTaskInput } from "./tasks.ts";

/**
 * An agent creation as Cowork asks for it: a container host whose mounts were
 * browsed on the daemon.
 *
 * `WireHostSpec`, so no `image`. The daemon refuses that field from a paired
 * device, and a type that allowed it here would let this app ship a request
 * that can only ever come back as a refusal.
 */
export interface AgentCreateRequest {
  name: string;
  cwd: string;
  host: WireHostSpec;
}

export interface CoworkClient {
  connectionState: ConnectionState;
  readSkills(cwd?: string, agentId?: string): void;
  readConnectors(cwd?: string, agentId?: string): void;
  readTasks(): void;
  createTask(input: NewTaskInput & { agentId: AgentId }): void;
  cancelTask(taskId: string): void;
  createAgent(request: AgentCreateRequest): void;
  on(name: "skills", listener: (event: SkillsEvent) => void): () => void;
  on(name: "connectors", listener: (event: ConnectorsEvent) => void): () => void;
  on(name: "tasks", listener: (event: TasksEvent) => void): () => void;
  on(name: "task", listener: (event: TaskEvent) => void): () => void;
  on(name: "agent_created", listener: (event: AgentCreatedEvent) => void): () => void;
  on(name: "error", listener: (event: ClientErrorEvent) => void): () => void;
  on(name: "status", listener: (event: StatusEvent) => void): () => void;
}
