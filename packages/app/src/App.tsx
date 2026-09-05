/**
 * The whole app: pair, choose a saved daemon, or take the position.
 *
 * Boot state decides which of two things is on screen, and each is a navigator
 * rather than a hand-swapped screen: `PairNavigator` before there is a
 * credential, `Console`'s shell after. Only one is ever mounted, they share one
 * theme and one stack behaviour, and neither is reachable from the other by
 * anything but the store: a device stops pairing because a credential was
 * written, not because a screen decided to change.
 *
 * The connections screen and the invite screen used to live here, one behind a
 * boot phase and one behind a strip pinned to the bottom of the console. They
 * are routes in the shell now, reached from its menu, which is why this file no
 * longer draws anything of its own but the boot spinner.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Console } from "./console/Console.tsx";
import { OmpThemeProvider } from "./design/OmpTheme.tsx";
import { SafeScreen } from "./design/SafeScreen.tsx";
import { ink } from "./design/tokens.ts";
import { PairNavigator } from "./nav/PairNavigator.tsx";
import type { Connection, ConnectionList, SavedConnection } from "./platform/connection.ts";
import { clearConnection, loadConnections, saveConnection, setActiveConnection } from "./platform/connection.ts";
import { listenForDeepLinks } from "./platform/deeplink.ts";
import { nativeDeepLinks } from "./platform/deeplink-source";
import { CollabSessionScreen } from "./screens/CollabSessionScreen.tsx";

type Boot =
  | { phase: "loading" }
  | { phase: "pair"; notice?: string; connections?: ConnectionList }
  | { phase: "console"; connections: ConnectionList };


export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [collabRoomId, setCollabRoomId] = useState<string | null>(null);

  const showConnections = useCallback((connections: ConnectionList, notice?: string) => {
    const active = connections.connections.find(entry => entry.id === connections.activeId);
    setBoot(active === undefined ? { phase: "pair", notice, connections } : { phase: "console", connections });
  }, []);

  const reloadConnections = useCallback(
    async (notice?: string) => {
      showConnections(await loadConnections(), notice);
    },
    [showConnections],
  );

  useEffect(() => {
    let cancelled = false;
    void loadConnections()
      .then(connections => {
        if (!cancelled) showConnections(connections);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBoot({ phase: "pair", notice: describe(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [showConnections]);

  /** The store is written before the Console opens, never only into React state. */
  const pair = useCallback(
    async (connection: Connection) => {
      await saveConnection(connection);
      await reloadConnections();
    },
    [reloadConnections],
  );


  // A pairing link is durable before it is visible: the credential is written
  // to the store, then the Console opens, so a link that arrives during a cold
  // start cannot leave a device that looks paired but has saved nothing.
  useEffect(
    () =>
      listenForDeepLinks(nativeDeepLinks, {
        openCollabSession: setCollabRoomId,
        openPairing: link => {
          void saveConnection({
            transport: "hub",
            hubUrl: link.hubUrl,
            daemonId: link.daemonId,
            token: link.token,
            // The grant the link was minted with, when it carried one. A
            // hint for the first paint only: hello reports the daemon's own
            // record and the console prefers that.
            scopes: link.scopes,
          })
            .then(() => reloadConnections())
            .catch((cause: unknown) => setBoot({ phase: "pair", notice: describe(cause) }));
        },
      }),
    [reloadConnections],
  );

  const activate = useCallback(
    async (id: string) => {
      await setActiveConnection(id);
      await reloadConnections();
    },
    [reloadConnections],
  );

  /** A rejected token removes only its own pairing, preserving every other daemon. */
  const unpair = useCallback(
    async (id: string, notice?: string) => {
      await clearConnection(id);
      await reloadConnections(notice);
    },
    [reloadConnections],
  );

  let body: JSX.Element;
  if (boot.phase === "loading") {
    body = (
      <SafeScreen style={styles.boot} testID="boot">
        <ActivityIndicator color={ink.plain} />
      </SafeScreen>
    );
  } else if (boot.phase === "pair") {
    // Present only when there is a saved daemon behind this form: adding a
    // second pairing must be cancellable back to the one already working.
    const saved = boot.connections;
    body = (
      <PairNavigator
        notice={collabRoomId === null ? boot.notice : "Pair this device to join the shared room."}
        onCancel={saved === undefined ? undefined : () => showConnections(saved)}
        onPair={pair}
      />
    );
  } else {
    const active = boot.connections.connections.find(entry => entry.id === boot.connections.activeId);
    if (active === undefined) {
      body = <PairNavigator onPair={pair} />;
    } else if (collabRoomId !== null) {
      body = (
        <CollabSessionScreen
          roomId={collabRoomId}
          connection={active.connection}
          onClose={() => setCollabRoomId(null)}
        />
      );
    } else {
      body = (
        <Console
          // Rebuilt when the daemon behind it changes, never re-pointed: the
          // socket, the reducer, and the navigation state all belong to one
          // pairing, and carrying any of them across two daemons would show one
          // machine's sessions under another's credential.
          key={consoleKey(active)}
          connection={active.connection}
          daemonLabel={active.label}
          connections={boot.connections}
          onAddConnection={() => setBoot({ phase: "pair", connections: boot.connections })}
          onSelectConnection={id => {
            void activate(id);
          }}
          onUnpair={notice => {
            void unpair(active.id, notice);
          }}
        />
      );
    }
  }

  // The design system spans everything, inside the safe-area provider because
  // Paper's own components read the insets through it.
  return (
    <SafeAreaProvider>
      <OmpThemeProvider>{body}</OmpThemeProvider>
    </SafeAreaProvider>
  );
}

function consoleKey(active: SavedConnection): string {
  const connection = active.connection;
  return connection.transport === "direct"
    ? `${active.id}:${connection.url}:${connection.token.length}`
    : `${active.id}:${connection.hubUrl}:${connection.daemonId}:${connection.token.length}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  boot: { alignItems: "center", justifyContent: "center" },
});
