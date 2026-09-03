/**
 * The route: a browser over the daemon's own directories, wired to a socket.
 *
 * Two prop shapes, and the difference is only who owns the socket. Handed a
 * `connection`, this builds its own client and closes it on unmount, which is
 * what a navigator can do without reaching into the console's internals.
 * Handed a `client`, it uses the one already serving the app and never starts
 * or closes it. Nothing else differs, which is the point: the screen below is
 * the same either way.
 *
 * `onOpened` exists so a navigator can follow a session the operator just
 * started. It is optional because the console already subscribes to
 * `session_opened` and selects what arrives: on a shared client, that alone
 * puts the new session on screen, and this callback is only about which route
 * the navigator should be showing when it does.
 */

import type { AgentId } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { createOmpdClient } from "../console/useConsole.ts";
import type { Connection } from "../platform/connection.ts";
import { type RemoteStartClient, useRemoteStart } from "../remote/useRemoteStart.ts";
import { BrowseScreen } from "./BrowseScreen.tsx";

interface CommonProps {
  onBack?: () => void;
  /** Called with the agent the daemon created for a session started here. */
  onOpened?: (agentId: AgentId) => void;
}

/** The navigator hands over a pairing and this screen owns one socket for its lifetime. */
export interface RemoteStartScreenOwnedProps extends CommonProps {
  connection: Connection;
  client?: never;
}

/** The caller hands over an already-started client and keeps owning it. */
export interface RemoteStartScreenSharedProps extends CommonProps {
  client: RemoteStartClient;
  connection?: never;
}

export type RemoteStartScreenProps = RemoteStartScreenOwnedProps | RemoteStartScreenSharedProps;

export function RemoteStartScreen(props: RemoteStartScreenProps): JSX.Element {
  const client = useScreenClient(props);
  const [state, actions] = useRemoteStart(client, props.onOpened);

  return (
    <BrowseScreen
      state={state}
      onOpenChild={actions.openChild}
      onOpenPath={actions.open}
      onUp={actions.up}
      onRefresh={actions.refresh}
      onStartHere={actions.startHere}
      onCloneHere={actions.cloneHere}
      onDismissNotice={actions.dismissNotice}
      onDismissClone={actions.dismissClone}
      {...(props.onBack === undefined ? {} : { onBack: props.onBack })}
    />
  );
}

/**
 * The client this screen drives, and the lifetime that goes with it.
 *
 * Built once per mount and never per render, for the reason `useConsole` builds
 * its own that way: a new socket per render is a reconnect loop that looks like
 * a flaky daemon. Closed on unmount only when this screen created it.
 */
function useScreenClient(props: RemoteStartScreenProps): RemoteStartClient {
  const owned = useRef<OmpdClient | null>(null);
  if (props.client === undefined && owned.current === null) {
    owned.current = createOmpdClient(props.connection);
  }

  useEffect(() => {
    const socket = owned.current;
    if (socket === null) return;
    socket.start();
    return () => socket.close();
  }, []);

  const shared = props.client;
  if (shared !== undefined) return shared;
  const created = owned.current;
  // Unreachable: the branch above created one whenever `client` was absent.
  // Stated rather than asserted away, so a future edit to that branch fails
  // here instead of at the first frame this screen tries to send.
  if (created === null) throw new Error("RemoteStartScreen has no client and no connection to build one from");
  return created;
}
