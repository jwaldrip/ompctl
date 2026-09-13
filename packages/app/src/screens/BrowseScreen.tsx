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
import { Glyph, type GlyphName } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { SafeScreen, useOwnedBottomInset } from "../design/SafeScreen.tsx";
import { Body, Code, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { bottomInsetFor, useKeyboardInset } from "../design/useKeyboardInset.ts";
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
  /** The same directory browser selects a read-only mount for Cowork. */
  onBindFolder?: (path: string) => void;
  onCloneHere: (url: string) => void;
  onDismissNotice: () => void;
  onDismissClone: () => void;
  /** Open a file entry in the artifact viewer. */
  onOpenFile?: (entry: FsEntry, fullPath: string) => void;
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
  onBindFolder,
  onCloneHere,
  onDismissNotice,
  onDismissClone,
  onOpenFile,
  onBack,
}: BrowseScreenProps): JSX.Element {
  const [url, setUrl] = useState("");
  const atRoots = state.path === "";
  const keyboard = useKeyboardInset();
  const bottom = useOwnedBottomInset();
  const binding = onBindFolder !== undefined;

  return (
    <SafeScreen edges={{ bottom: false }} style={styles.screen} testID="browse-screen">
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {onBack === undefined ? null : (
            <Pressable accessibilityRole="button" onPress={onBack} style={styles.headerButton} testID="browse-back">
              <Glyph name="back" color={ink.plain} />
            </Pressable>
          )}
          <View style={styles.headerCopy}>
            <Kicker>{binding ? "Bound folders" : "New session"}</Kicker>
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
          <Glyph name="warning" color={signal.holding} size={13} />
          <Label color={signal.holding} style={styles.noticeText}>
            {state.notice}
          </Label>
        </Pressable>
      )}

      {state.clone === null ? null : (
        <View style={styles.inset}>
          <CloneProgress clone={state.clone} onDismiss={onDismissClone} onOpenDestination={onOpenPath} />
        </View>
      )}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} testID="browse-entries">
        {state.entries.map(entry => {
          const fullPath = atRoots ? entry.name : state.path === "" ? entry.name : `${state.path}/${entry.name}`;
          const isFile = entry.kind === "file";
          const handlePress = () => {
            if (isFile && onOpenFile !== undefined) {
              onOpenFile(entry, fullPath);
            } else if (atRoots) {
              onOpenPath(entry.name);
            } else {
              onOpenChild(entry.name);
            }
          };
          return (
            <EntryRow
              canOpenFile={onOpenFile !== undefined}
              entry={entry}
              key={entry.name}
              onPress={handlePress}
              showFullPath={atRoots}
            />
          );
        })}
        {state.loading ? <Label color={ink.muted}>Loading folders.</Label> : null}
        {!state.listed && !state.loading && state.notice === null ? (
          <Label color={ink.muted}>Waiting for the daemon's folder listing.</Label>
        ) : null}
        {state.listed && state.entries.length === 0 && !state.loading ? (
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

      <View style={[styles.actions, { paddingBottom: rhythm.rowGap + bottomInsetFor(keyboard, bottom) }]}>
        {/* Starting at the roots still explains the refusal through the hook.
            A binding has no daemon request, so its unavailable state must be
            explained here before a path can leave this screen. */}
        <Pressable
          accessibilityRole="button"
          // Wrapped rather than passed through: `onPress` hands its handler a
          // gesture event, and a handler whose first parameter is an optional
          // name would take that event as the name.
          disabled={binding && atRoots}
          accessibilityState={{ disabled: binding && atRoots }}
          onPress={() => (binding ? onBindFolder(state.path) : onStartHere())}
          style={[styles.start, binding && atRoots && styles.disabled]}
          testID={binding ? "browse-bind-folder" : "browse-start-here"}
        >
          <Glyph name="newTask" color={ink.inverse} size={13} />
          <Text style={styles.startText}>{binding ? "Bind this folder" : "Start a session here"}</Text>
        </Pressable>
        {binding ? (
          <Label color={ink.muted} testID="browse-bind-hint">
            {atRoots
              ? "Open a directory first: the roots view is a menu, not a folder."
              : "The container will mount " + state.path + " read-only, at this same path."}
          </Label>
        ) : null}
        <Label color={ink.muted}>Clone using an HTTPS or SSH URL. Git runs on your daemon.</Label>
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
            accessibilityState={{ disabled: url.trim().length === 0 }}
            // Disabled only while the field is empty, which the field's own
            // placeholder already says. At the roots view it stays pressable
            // with a url in it, so the tap is answered with why it cannot
            // land rather than silently ignored.
            disabled={url.trim().length === 0}
            onPress={() => {
              onCloneHere(url.trim());
              // Cleared on send, like the composer: the field is a draft, and a
              // url left sitting in it after a clone started reads as a clone
              // that has not started yet.
              setUrl("");
            }}
            style={[styles.clone, url.trim().length === 0 && styles.disabled]}
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

function getFileGlyph(name: string): GlyphName {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "browser";
  if (ext === "diff" || ext === "patch") return "edit";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "svg") {
    return "attachment";
  }
  if (ext === "mp4" || ext === "webm" || ext === "mov" || ext === "mkv") return "resume";
  return "read";
}

function EntryRow({
  entry,
  onPress,
  showFullPath,
  canOpenFile = false,
}: {
  entry: FsEntry;
  onPress: () => void;
  /** Roots are absolute, so their row shows the whole path rather than a name. */
  showFullPath: boolean;
  canOpenFile?: boolean;
}): JSX.Element {
  const openable = entry.kind === "dir" || (entry.kind === "file" && canOpenFile);
  const glyphName: GlyphName =
    entry.kind === "dir" ? "folder" : entry.kind === "link" ? "symlink" : getFileGlyph(entry.name);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !openable }}
      disabled={!openable}
      onPress={onPress}
      style={styles.entry}
      testID={`browse-entry-${entry.name}`}
    >
      <Glyph name={glyphName} color={entry.kind === "file" && !openable ? ink.faint : ink.plain} />
      <Label
        color={entry.kind === "file" && !openable ? ink.muted : ink.bright}
        numberOfLines={1}
        style={styles.entryName}
        testID={showFullPath ? `browse-root-${entry.name}` : undefined}
      >
        {entry.name}
      </Label>
      {entry.kind === "link" ? <Label color={ink.faint}>not followed</Label> : null}
      {entry.gitRepo === true ? (
        <View style={styles.repoTag} testID={`browse-repo-${entry.name}`}>
          <Glyph name="repo" color={signal.ready} size={11} />
          <Label color={signal.ready}>repo</Label>
        </View>
      ) : null}
      {openable ? <Glyph name="chevron" color={ink.faint} size={11} /> : null}
    </Pressable>
  );
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
  /** A card between the header and the list keeps the screen's gutter. */
  inset: { paddingHorizontal: rhythm.gutter, paddingBottom: rhythm.rowGap },
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
  repoTag: { alignItems: "center", flexDirection: "row", gap: space.tight },
  bounded: { paddingVertical: space.step },
  // Pinned under the list: these are the two reasons the screen exists, and a
  // thumb has to reach them without scrolling.
  actions: { gap: space.snug, paddingHorizontal: rhythm.gutter, paddingVertical: rhythm.rowGap },
  start: {
    alignItems: "center",
    backgroundColor: signal.ready,
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
