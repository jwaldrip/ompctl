/**
 * Choose where the next piece of work happens, standing up, one-handed.
 *
 * That sentence is the whole design brief and it settles most of the layout.
 * The two things an operator came here to do -- start a session here, clone
 * into here -- are pinned to the bottom of the screen where a thumb reaches,
 * not at the top where a list scrolls them away. The list is the middle. The
 * header says where "here" is, in one line, with the way up next to it.
 *
 * Git working trees are marked, because that is what someone is looking for
 * when they pick a place for an agent to act. A bounded listing says so in the
 * list rather than in a toast: the notice belongs where the missing entries
 * would have been, so nobody reads a page as a whole directory.
 *
 * Pure by construction: every gesture is a prop. `RemoteStartScreen` is what
 * wires these to a socket.
 */

import type { FsEntry } from "@ompd/core/contracts";
import type { JSX } from "react";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CloneProgress } from "../components/CloneProgress.tsx";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Code, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { directoryLabel, type RemoteStartState } from "../remote/model.ts";

export interface BrowseScreenProps {
  state: RemoteStartState;
  /** Open an entry by name, within the directory on screen. */
  onOpenChild: (name: string) => void;
  /** Open one absolute path: a root, or a clone's destination. */
  onOpenPath: (path: string) => void;
  onUp: () => void;
  onRefresh: () => void;
  onStartHere: () => void;
  onCloneHere: (url: string) => void;
  onDismissNotice: () => void;
  onDismissClone: () => void;
  /** Leave the screen. Absent, the back affordance is not drawn. */
  onBack?: () => void;
}

export function BrowseScreen({
  state,
  onOpenChild,
  onOpenPath,
  onUp,
  onRefresh,
  onStartHere,
  onCloneHere,
  onDismissNotice,
  onDismissClone,
  onBack,
}: BrowseScreenProps): JSX.Element {
  const [url, setUrl] = useState("");
  const atRoots = state.path === "";

  return (
    <SafeScreen style={styles.screen} testID="browse-screen">
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {onBack === undefined ? null : (
            <Pressable accessibilityRole="button" onPress={onBack} style={styles.headerButton} testID="browse-back">
              <Glyph name="back" color={ink.plain} />
            </Pressable>
          )}
          <View style={styles.headerCopy}>
            <Kicker>New session</Kicker>
            <Title heading numberOfLines={1} testID="browse-title">
              {directoryLabel(state.path)}
            </Title>
          </View>
          {atRoots ? null : (
            <Pressable accessibilityRole="button" onPress={onUp} style={styles.headerButton} testID="browse-up">
              <Glyph name="up" color={ink.plain} />
            </Pressable>
          )}
          <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.headerButton} testID="browse-refresh">
            <Glyph name="restore" color={ink.plain} />
          </Pressable>
        </View>
        <Code numberOfLines={1} testID="browse-path">
          {atRoots ? "the directories this daemon will answer about" : state.path}
        </Code>
      </View>

      {state.notice === null ? null : (
        <Pressable accessibilityRole="button" onPress={onDismissNotice} style={styles.notice} testID="browse-notice">
          <Glyph name="warning" color={signal.ochre} size={13} />
          <Label color={signal.ochre} style={styles.noticeText}>
            {state.notice}
          </Label>
        </Pressable>
      )}

      {state.clone === null ? null : (
        <CloneProgress clone={state.clone} onDismiss={onDismissClone} onOpenDestination={onOpenPath} />
      )}

      <ScrollView style={styles.list} testID="browse-entries">
        {state.entries.map(entry => (
          <EntryRow
            entry={entry}
            key={entry.name}
            onPress={() => (atRoots ? onOpenPath(entry.name) : onOpenChild(entry.name))}
            showFullPath={atRoots}
          />
        ))}
        {state.entries.length === 0 && !state.loading ? (
          <Body color={ink.muted} testID="browse-empty">
            {atRoots ? "This daemon is configured to browse nothing." : "Nothing in here."}
          </Body>
        ) : null}
        {state.bounded ? (
          <View style={styles.bounded} testID="browse-bounded">
            <Label color={ink.muted}>
              Showing the first {state.entries.length}. This directory holds more than one screenful.
            </Label>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: atRoots }}
          disabled={atRoots}
          // Wrapped rather than passed through: `onPress` hands its handler a
          // gesture event, and a handler whose first parameter is an optional
          // name would take that event as the name.
          onPress={() => onStartHere()}
          style={[styles.start, atRoots && styles.disabled]}
          testID="browse-start-here"
        >
          <Glyph name="newTask" color={ink.inverse} size={13} />
          <Text style={styles.startText}>Start a session here</Text>
        </Pressable>

        <View style={styles.cloneRow}>
          <TextInput
            accessibilityLabel="Repository url to clone"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setUrl}
            placeholder="git@github.com:you/repo.git"
            placeholderTextColor={ink.faint}
            style={styles.cloneInput}
            testID="browse-clone-url"
            value={url}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: atRoots || url.trim().length === 0 }}
            disabled={atRoots || url.trim().length === 0}
            onPress={() => {
              onCloneHere(url.trim());
              // Cleared on send, like the composer: the field is a draft, and a
              // url left sitting in it after a clone started reads as a clone
              // that has not started yet.
              setUrl("");
            }}
            style={[styles.clone, (atRoots || url.trim().length === 0) && styles.disabled]}
            testID="browse-clone-here"
          >
            <Glyph name="repo" color={ink.bright} size={13} />
            <Text style={styles.cloneText}>Clone</Text>
          </Pressable>
        </View>
      </View>
    </SafeScreen>
  );
}

function EntryRow({
  entry,
  onPress,
  showFullPath,
}: {
  entry: FsEntry;
  onPress: () => void;
  /** Roots are absolute, so their row shows the whole path rather than a name. */
  showFullPath: boolean;
}): JSX.Element {
  const openable = entry.kind !== "file";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !openable }}
      disabled={!openable}
      onPress={onPress}
      style={styles.entry}
      testID={`browse-entry-${entry.name}`}
    >
      <Glyph
        name={entry.kind === "dir" ? "folder" : entry.kind === "link" ? "symlink" : "read"}
        color={entry.kind === "file" ? ink.faint : ink.plain}
      />
      <Label
        color={entry.kind === "file" ? ink.muted : ink.bright}
        numberOfLines={1}
        style={styles.entryName}
        testID={showFullPath ? `browse-root-${entry.name}` : undefined}
      >
        {entry.name}
      </Label>
      {entry.gitRepo === true ? (
        <View style={styles.repoTag} testID={`browse-repo-${entry.name}`}>
          <Glyph name="repo" color={signal.sage} size={11} />
          <Label color={signal.sage}>repo</Label>
        </View>
      ) : null}
      {openable ? <Glyph name="chevron" color={ink.faint} size={11} /> : null}
    </Pressable>
  );
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
  repoTag: { alignItems: "center", flexDirection: "row", gap: space.tight },
  bounded: { paddingVertical: space.step },
  // Pinned under the list: these are the two reasons the screen exists, and a
  // thumb has to reach them without scrolling.
  actions: { gap: space.snug },
  start: {
    alignItems: "center",
    backgroundColor: signal.sage,
    flexDirection: "row",
    gap: space.snug,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  startText: { ...type.title, color: ink.inverse },
  cloneRow: { flexDirection: "row", gap: space.snug },
  cloneInput: {
    ...type.code,
    backgroundColor: ground.surface,
    borderColor: ground.line,
    borderWidth: stroke.hair,
    color: ink.bright,
    flex: 1,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
  },
  clone: {
    alignItems: "center",
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    flexDirection: "row",
    gap: space.snug,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  cloneText: { ...type.label, color: ink.bright },
  disabled: { opacity: 0.45 },
});
