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

import type { FsEntry, ProviderRepo } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CloneProgress } from "../components/CloneProgress.tsx";
import { RepositoryPicker } from "../components/ProjectPicker.tsx";
import { createOmpdClient } from "../console/useConsole.ts";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Code, Kicker, Label, Title } from "../design/text.tsx";
import { brand, ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { directoryLabel } from "../remote/model.ts";
import { type RemoteStartClient, useRemoteStart } from "../remote/useRemoteStart.ts";

interface CommonProps {
  /** Called with the absolute, daemon-resolved path of the directory on screen. */
  onPick: (path: string) => void;
  /** Leave without choosing. Absent, the back affordance is not drawn. */
  onBack?: () => void;
  /** Repository to clone into the chosen destination. */
  repoToClone?: ProviderRepo | { url: string; name?: string } | null;
  /** Mode: "bind" for cowork bindings (default), "clone" for destination selection. */
  mode?: "bind" | "clone";
  /** Called when a clone finishes and creates a new session. */
  onSessionOpened?: (sessionId: string) => void;
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
  const offerable = state.path !== "";

  const [selectedRepo, setSelectedRepo] = useState<ProviderRepo | { url: string; name?: string } | null>(
    props.repoToClone ?? null,
  );
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const isCloneMode = props.mode === "clone" || selectedRepo !== null;

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
            <Kicker>{isCloneMode ? "Clone destination" : "Bound folders"}</Kicker>
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
          <Glyph name="warning" color={signal.holding} size={13} />
          <Label color={signal.holding} style={styles.noticeText}>
            {state.notice}
          </Label>
        </Pressable>
      )}
      {state.clone === null ? null : (
        <View style={styles.cloneInset}>
          <CloneProgress
            clone={state.clone}
            onDismiss={actions.dismissClone}
            onOpenDestination={() => actions.startHere()}
          />
        </View>
      )}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} testID="folder-picker-entries">
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
        {isCloneMode ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !offerable }}
              disabled={!offerable}
              onPress={() => {
                if (selectedRepo) {
                  const url = "cloneUrl" in selectedRepo ? selectedRepo.cloneUrl : selectedRepo.url;
                  actions.cloneHere(url, selectedRepo.name);
                } else {
                  setShowRepoPicker(true);
                }
              }}
              style={[styles.bind, !offerable && styles.disabled]}
              testID="folder-picker-clone-confirm"
            >
              <Glyph name="repo" color={ink.inverse} size={13} />
              <Text style={styles.bindText}>
                {selectedRepo ? `Clone into ${directoryLabel(state.path)}` : "Pick a repository to clone"}
              </Text>
            </Pressable>
            <Label color={ink.muted} numberOfLines={2} testID="folder-picker-confirm-hint">
              {offerable
                ? selectedRepo
                  ? `Will clone into ${state.path}. Existing directories or repositories will be refused.`
                  : `Destination directory: ${state.path}`
                : "Open a directory first: the roots view is a menu, not a folder."}
            </Label>
          </>
        ) : (
          <>
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
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowRepoPicker(true)}
              style={styles.cloneAffordance}
              testID="folder-picker-open-repo-picker"
            >
              <Glyph name="repo" color={brand.azure} size={12} />
              <Label color={brand.azure}>Or clone a repository here</Label>
            </Pressable>
          </>
        )}
      </View>

      {showRepoPicker ? (
        <RepositoryPicker
          defaultOpen={true}
          onSelectRepo={repo => {
            setSelectedRepo(repo);
            setShowRepoPicker(false);
            if (offerable) {
              actions.cloneHere(repo.cloneUrl, repo.name);
            }
          }}
          onSelectUrl={url => {
            setSelectedRepo({ url });
            setShowRepoPicker(false);
            if (offerable) {
              actions.cloneHere(url);
            }
          }}
          onBack={() => setShowRepoPicker(false)}
        />
      ) : null}
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
  // No padding and no gap at the screen: the list is a scroll field and runs
  // edge to edge, its rule spanning the full width and its bar at the very
  // edge. The chrome above and below pays the gutter for itself, and the
  // rows pay it as content, where it scrolls with them.
  screen: { backgroundColor: ground.base },
  header: {
    gap: space.tight,
    paddingHorizontal: rhythm.gutter,
    paddingTop: rhythm.gutter,
    paddingBottom: rhythm.rowGap,
  },
  headerRow: { alignItems: "center", flexDirection: "row", gap: space.snug },
  headerButton: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET },
  headerCopy: { flex: 1, gap: space.hair },
  notice: {
    alignItems: "center",
    backgroundColor: ground.surface,
    borderColor: signal.holding,
    borderWidth: stroke.hair,
    flexDirection: "row",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    marginHorizontal: rhythm.gutter,
    marginBottom: rhythm.rowGap,
  },
  noticeText: { flex: 1 },
  list: { borderColor: ground.edge, borderTopWidth: stroke.hair, flex: 1 },
  listContent: { paddingHorizontal: rhythm.gutter, paddingBottom: rhythm.rowGap },
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
  actions: { gap: space.snug, paddingHorizontal: rhythm.gutter, paddingVertical: rhythm.rowGap },
  bind: {
    alignItems: "center",
    backgroundColor: signal.ready,
    flexDirection: "row",
    gap: space.snug,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  bindText: { ...type.title, color: ink.inverse },
  disabled: { opacity: 0.45 },
  cloneInset: {
    marginHorizontal: rhythm.gutter,
    marginBottom: rhythm.rowGap,
  },
  cloneAffordance: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingVertical: space.snug,
  },
});
