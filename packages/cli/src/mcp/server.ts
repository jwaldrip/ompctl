/**
 * The routines MCP server, spoken over stdio.
 *
 * One rule dominates this file: stdout belongs to the transport. JSON-RPC
 * framing is length-delimited lines on that stream, so a single stray byte,
 * one banner, one stray `console.log` from anywhere in the process, desyncs
 * the reader and the client simply sees a server that stopped answering. There
 * is no error for it and nothing in the logs. So the context handed to the
 * tools has its `out` pointed at `err`, and that shaping happens here rather
 * than at the call site, because a caller passing its ordinary context is the
 * obvious mistake and it would not look like one.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OMPD_VERSION } from "@ompd/daemon";
import type { CliContext } from "../client.ts";
import { registerRoutineTools } from "./tools.ts";

export { ROUTINE_TOOL_NAMES } from "./tools.ts";

/**
 * Serve the routine tools on stdin and stdout until the client goes away.
 *
 * Resolves when the transport closes, which is the signal to exit: an MCP
 * client owns this process' lifetime, and there is nothing left to serve once
 * it has hung up.
 */
export async function serveRoutinesMcp(ctx: CliContext): Promise<void> {
  // Both writers go to stderr. A tool that printed to stdout would corrupt
  // the framing, and stderr is where an MCP client collects a server's
  // human-readable output anyway.
  const quiet: CliContext = { ...ctx, out: ctx.err };

  // Same version the CLI reports for `--version`, so a client comparing the
  // two is comparing one number rather than discovering a second one.
  const server = new McpServer({ name: "ompctl", version: OMPD_VERSION });
  registerRoutineTools(server, quiet);

  const transport = new StdioServerTransport();
  const closed = new Promise<void>(resolve => {
    // Taken from the server and not the transport: `connect` replaces the
    // transport's own `onclose` with its own handler, so a callback set here
    // would be overwritten and never fire.
    server.server.onclose = () => resolve();

    // The transport watches stdin for data and errors, never for its end. A
    // client that says goodbye by closing the pipe instead of killing the
    // process would otherwise leave this one alive, holding a session nobody
    // is on the other end of.
    process.stdin.once("end", () => {
      server.close().catch(() => resolve());
    });
  });

  await server.connect(transport);
  await closed;
}
