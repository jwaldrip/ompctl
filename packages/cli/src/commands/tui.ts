/**
 * `ompd tui`.
 *
 * Goes over the same daemon-attach protocol as any other client (the web
 * console, a phone): the agent's lifetime belongs to the daemon's
 * `Supervisor`, not to this process, so quitting or killing the TUI never
 * touches a running turn. See `../tui/client-mode.ts` for the attach
 * lifecycle itself; this command only resolves flags into
 * `RunClientModeOptions` and initializes the terminal theme before handing
 * off.
 */

import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Command } from "../args.ts";
import type { CliContext } from "../client.ts";
import { runClientMode } from "../tui/client-mode.ts";
import { DEFAULT_OMPD_PORT } from "../tui/daemon-config.ts";

export async function tuiCommand(_ctx: CliContext, cmd: Extract<Command, { kind: "tui" }>): Promise<number> {
  await initTheme();

  // `daemonUrl` only overrides `runClientMode`'s own resolution (OMPD_URL,
  // then the endpoint file at <home>/endpoint) when the operator actually
  // typed --host or --port; leaving it undefined otherwise means a bare
  // `ompd tui` finds the daemon exactly the way every other command does.
  const daemonUrl =
    cmd.host !== undefined || cmd.port !== undefined
      ? `http://${cmd.host ?? "127.0.0.1"}:${cmd.port ?? DEFAULT_OMPD_PORT}`
      : undefined;

  return runClientMode({ daemonUrl, token: cmd.token });
}
