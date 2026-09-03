/**
 * The folder picker: one directory on the daemon's own disk, chosen from a phone.
 *
 * Cowork work is scoped to bound directories, and the machine whose folders
 * get mounted is the daemon's, never the phone's: the listing this screen
 * draws rides the same `fs_list` frames RemoteStart does, through a client
 * this screen owns for its lifetime when handed a `connection` (the
 * RemoteStartScreen split: own the socket, or share the caller's). The listing
 * machinery itself is `useRemoteStart`'s, reused rather than reimplemented,
 * because asking for a directory, walking up, and hearing a refusal are the
 * same acts here as they are there; only what the bottom button does with the
 * directory on screen differs.
 *
 * Two refusals are by design rather than omissions. A symlink is listed but
 * never offered: the daemon marked it `link` precisely because it did not
 * follow it, so this screen cannot vouch that opening it stays inside the
 * roots, and refusing to offer what cannot be listed beats an error two taps
 * into a browse. And the confirm control is not offered at the roots view,
 * because the roots listing is a menu rather than a directory: there is no
 * absolute path on screen to confirm, and the hint says so instead of guessing.
 */

import type { FsEntry } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { createOmpdClient } from "../console/useConsole.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Code, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { directoryLabel } from "../remote/model.ts";
import { type RemoteStartClient, useRemoteStart } from "../remote/useRemoteStart.ts";

interface CommonProps {
  /** Called with the absolute, daemon-resolved path of the directory on screen. */
  onPick: (path: string) => void;
  /** Leave without choosing. Absent, the back affordance is not drawn. */
  onBack?: () => void;
}

/** The caller hands over a pairing and this screen owns one socket for its lifetime. */
export interface FolderPickerScreenOwnedProps extends CommonProps {
  connection: Connection;
  client?: never;
}

/** The caller hands over an already-started client and keeps owning it. */
export interface FolderPickerScreenSharedProps extends CommonProps {
  client: RemoteStartClient;
  connection?: never;
}

export type FolderPickerScreenProps = FolderPickerScreenOwnedProps | FolderPickerScreenSharedProps;

export function FolderPickerScreen(props: FolderPickerScreenProps): JSX.Element {
  const client = useScreenClient(props);
  const [state, actions] = useRemoteStart(client);
  const atRoots = state.path === "";
  // A directory is offerable once its own listing has arrived: the confirmed
  // path is `state.path` itself, resolved by the daemon, and a path this
  // screen only hoped for would be binding a guess. A listing already on
  // screen stays offerable while the next one loads, because the directory it
  // describes is real whichever answer is in flight.
  const offerable = state.path !== "";

  return (
    <SafeScreen style={styles.screen} testID="folder-picker-screen">
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {props.onBack === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={props.onBack}
              style={styles.headerButton}
              testID="folder-picker-back"
            >
              <Glyph name="back" color={ink.plain} />
            </Pressable>
          )}
          <View style={styles.headerCopy}>
            <Kicker>Bound folders</Kicker>
            <Title heading numberOfLines={1} testID="folder-picker-title">
              {directoryLabel(state.path)}
            </Title>
          </View>
          {atRoots ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={actions.up}
              style={styles.headerButton}
              testID="folder-picker-up"
            >
              <Glyph name="up" color={ink.plain} />
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={actions.refresh}
            style={styles.headerButton}
            testID="folder-picker-refresh"
          >
            <Glyph name="restore" color={ink.plain} />
          </Pressable>
        </View>
        <Code numberOfLines={1} testID="folder-picker-path">
          {atRoots ? "the directories this daemon will answer about" : state.path}
        </Code>
      </View>

      {state.notice === null ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={actions.dismissNotice}
          style={styles.notice}
          testID="folder-picker-notice"
        >
          <Glyph name="warning" color={signal.ochre} size={13} />
          <Label color={signal.ochre} style={styles.noticeText}>
            {state.notice}
          </Label>
        </Pressable>
      )}

      <ScrollView style={styles.list} testID="folder-picker-entries">
        {state.entries.map(entry => (
          <PickerRow
            entry={entry}
            key={entry.name}
            onOpen={() => (atRoots ? actions.open(entry.name) : actions.openChild(entry.name))}
          />
        ))}
        {state.entries.length === 0 && !state.loading ? (
          <Body color={ink.muted} testID="folder-picker-empty">
            {atRoots ? "This daemon is configured to browse nothing." : "Nothing in here."}
          </Body>
        ) : null}
        {state.bounded ? (
          <View style={styles.bounded} testID="folder-picker-bounded">
            <Label color={ink.muted}>
              Showing the first {state.entries.length}. This directory holds more than one screenful.
            </Label>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        {/* Not offered rather than silently swallowed: at the roots view the
            control is visibly idle with its reason beside it, because a
            disabled button that explains itself is a state, and one that
            swallows the tap reads as broken. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !offerable }}
          disabled={!offerable}
          onPress={() => props.onPick(state.path)}
          style={[styles.bind, !offerable && styles.disabled]}
          testID="folder-picker-confirm"
        >
          <Glyph name="folder" color={ink.inverse} size={13} />
          <Text style={styles.bindText}>Bind this folder</Text>
        </Pressable>
        <Label color={ink.muted} numberOfLines={2} testID="folder-picker-confirm-hint">
          {offerable
            ? `The container will mount ${state.path} read-only, at this same path.`
            : "Open a directory first: the roots view is a menu, not a folder."}
        </Label>
      </View>
    </SafeScreen>
  );
}

function PickerRow({ entry, onOpen }: { entry: FsEntry; onOpen: () => void }): JSX.Element {
  // Only a directory the daemon itself listed is offered. A file cannot be a
  // folder binding, and a symlink is the one entry the daemon deliberately did
  // not resolve, so this screen cannot promise it lands inside the roots: the
  // row stays, muted, with its reason next to it, rather than disappearing or
  // erroring two taps into a browse.
  const openable = entry.kind === "dir";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !openable }}
      disabled={!openable}
      onPress={onOpen}
      style={styles.entry}
      testID={`folder-picker-entry-${entry.name}`}
    >
      <Glyph
        name={entry.kind === "dir" ? "folder" : entry.kind === "link" ? "symlink" : "read"}
        color={openable ? ink.plain : ink.faint}
      />
      <Label color={openable ? ink.bright : ink.muted} numberOfLines={1} style={styles.entryName}>
        {entry.name}
      </Label>
      {entry.kind === "link" ? <Label color={ink.faint}>not followed</Label> : null}
      {openable ? <Glyph name="chevron" color={ink.faint} size={11} /> : null}
    </Pressable>
  );
}

/**
 * The client this screen drives, and the lifetime that goes with it.
 *
 * The same rule `RemoteStartScreen` applies to its own socket, written out
 * here rather than shared because that helper is private to a screen this
 * change does not own: built once per mount and never per render (a new socket
 * per render is a reconnect loop that looks like a flaky daemon), started on
 * mount, and closed on unmount only when this screen created it.
 */
function useScreenClient(props: FolderPickerScreenProps): RemoteStartClient {
  const owned = useRef<OmpdClient | null>(null);
  if (props.client === undefined && props.connection !== undefined && owned.current === null) {
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
  // Unreachable: the branch above created one whenever `client` was absent
  // and a connection was present, and the props union admits no third case.
  // Stated rather than asserted away, so a future edit that breaks that
  // branch fails here instead of at the first frame this screen tries to send.
  if (created === null) throw new Error("FolderPickerScreen has no client and no connection to build one from");
  return created;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, gap: space.step, padding: space.wide },
  header: { gap: space.tight },
  headerRow: { alignItems: "center", flexDirection: "row", gap: space.snug },
  headerButton: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET },
  headerCopy: { flex: 1, gap: space.hair },
  notice: {
    alignItems: "center",
    backgroundColor: ground.surface,
    borderColor: signal.ochre,
    borderWidth: stroke.hair,
    flexDirection: "row",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  noticeText: { flex: 1 },
  list: { borderColor: ground.edge, borderTopWidth: stroke.hair, flex: 1 },
  entry: {
    alignItems: "center",
    borderBottomColor: ground.line,
    borderBottomWidth: stroke.hair,
    flexDirection: "row",
    gap: space.step,
    minHeight: TOUCH_TARGET,
    paddingVertical: space.snug,
  },
  entryName: { flex: 1 },
  bounded: { paddingVertical: space.step },
  // Pinned under the list: confirming the directory on screen is the one
  // reason this screen exists, and a thumb has to reach it without scrolling.
  actions: { gap: space.snug },
  bind: {
    alignItems: "center",
    backgroundColor: signal.sage,
    flexDirection: "row",
    gap: space.snug,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  bindText: { ...type.title, color: ink.inverse },
  disabled: { opacity: 0.45 },
});
