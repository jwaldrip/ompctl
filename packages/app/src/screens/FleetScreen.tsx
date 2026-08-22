/**
 * The session browser: every session this device has ever launched, unless
 * explicitly archived.
 *
 * Rows are sessions, not just live agents: a session nobody has touched today
 * is still a first-class row, because the point of a browser over a fleet is
 * finding the thing you are not currently looking at. Grouping by working
 * directory is the primary organiser, on the same reasoning the contract
 * states it: 93 groups over 305 sessions is unusable flat, and grouping is
 * what makes "which project was that in" answerable at a glance. A cwd is
 * data about a session here, a display grouping, never its identity.
 *
 * This screen is fully controlled. It owns no state of its own; `browser` is
 * the whole picture (sessions, sort, archive visibility, grouping, which
 * groups are collapsed) and every gesture becomes a callback. That is what
 * lets a canned `BrowserState` produce byte-identical markup to a live one,
 * the same discipline `console/state.ts` applies to the socket.
 *
 * It is a block, not a shell: the route around it owns the system insets, so
 * the agent hub above it sits inside the safe area too rather than under the
 * status bar while this list pads itself in the middle of the screen.
 */

import type { JSX } from "react";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, type PressableStateCallbackType, SectionList, StyleSheet, View } from "react-native";
import { GroupHeader } from "../components/GroupHeader.tsx";
import { SessionRow } from "../components/SessionRow.tsx";
import { SortBar } from "../components/SortBar.tsx";
import type { ScopeAccess } from "../console/state.ts";
import { Glyph } from "../design/icons.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { BrowserSession, BrowserState, SessionGroup, SortField } from "../session/browser.ts";
import { browserView } from "../session/browser.ts";

export interface FleetScreenProps {
  browser: BrowserState;
  onSort: (field: SortField) => void;
  onToggleGroup: (cwd: string) => void;
  onToggleGrouped: () => void;
  onToggleArchived: () => void;
  onOpen: (session: BrowserSession) => void;
  onArchive: (session: BrowserSession) => void;
  onUnarchive: (session: BrowserSession) => void;
  /** Destroy one session's transcript. The row takes the operator through a confirmation first. */
  onDelete: (session: BrowserSession) => void;
  /**
   * Whether this pairing holds the manage scope deleting spends. `missing`
   * leaves every row's delete control on screen and disabled, and says so
   * once at the top rather than per row: a screen full of rows each
   * explaining the same missing grant is noise, and a control that vanished
   * would be a silent refusal.
   */
  deleteAccess: ScopeAccess;
  /** Injected so a test can pin the row clocks instead of racing the wall. */
  now?: number;
}

/**
 * Whether this row's open lands on the agent transcript (SessionScreen,
 * composer and all) rather than the terminal prompt surface. Mirrors the
 * ladder in `console/state.ts`: `live-ompd` attaches to its agent and
 * `dormant` rides the resume claim, both of which end on SessionScreen,
 * while `live-tui` is routed to TerminalSessionScreen, a screen with no
 * composer to drive. That distinction matters here because the status sort
 * puts live-tui rows FIRST (`STATUS_SEVERITY` ranks it 0 and `DEFAULT_SORT`
 * is status ascending), so the naive first row is exactly the row the path
 * scenario cannot use: it would open a terminal and then fail hunting for a
 * composer that screen never has. Archived rows are excluded too: they ride
 * the same resume claim, but the daemon's verifier refuses them, so their
 * open never reaches a transcript either.
 */
function opensAgentTranscript(session: BrowserSession): boolean {
  return session.status === "live-ompd" || session.status === "dormant";
}
/**
 * The first batch, and the ceiling on every batch after it.
 *
 * A 390x844 phone shows eight or nine of these rows, so twelve is a screenful
 * plus a look-ahead. This screen used to ask for the entire visible set on the
 * first pass, on the argument that a directory listing should never hide a row
 * from a search or a screen reader sweep. A real device settled it: 534
 * sessions across 93 groups made reaching this screen slow and scrolling it
 * worse, because every one of those rows mounted before the first frame and
 * re-rendered on every socket frame after it. A windowed list is what a phone
 * can actually draw; the header count still reports the whole corpus, so
 * nothing about the list's completeness is hidden.
 */
const FIRST_WINDOW = 12;

/** Viewports of cells kept mounted around the visible one. RN's default is 21. */
const WINDOW_SIZE = 5;

/** How long the virtualizer coalesces cell work. One frame at 60Hz is 16ms. */
const BATCH_PERIOD_MS = 50;

/** Stable and hoisted: a fresh element here would remount the empty state per render. */
const EMPTY = <Empty />;

const keyOf = (session: BrowserSession): string => session.id;

export function FleetScreen({
  browser,
  onSort,
  onToggleGroup,
  onToggleGrouped,
  onToggleArchived,
  onOpen,
  onArchive,
  onUnarchive,
  onDelete,
  deleteAccess,
  now,
}: FleetScreenProps): JSX.Element {
  const view = useMemo(() => browserView(browser), [browser]);
  // The sections array, both row renderers, and the section header renderer
  // are memoised because each is a prop the virtualizer compares. A new
  // identity per render re-renders the whole mounted window on every socket
  // frame, which on a phone is indistinguishable from never having windowed
  // the list at all. The path marker below reads the same memoised traversal
  // the list draws, so it can never land on a row a person cannot see.
  const sections = useMemo(
    () =>
      view.groups.map(group => ({
        cwd: group.cwd,
        group,
        data: browser.collapsedGroups.has(group.cwd) ? [] : group.sessions,
      })),
    [view.groups, browser.collapsedGroups],
  );

  // The one row the committed path scenario opens by name, in the order the
  // active list actually draws. Undefined when no visible row opens a
  // transcript, and then no row carries the marker: the scenario failing to
  // find it is the honest result, not a bug to paper over.
  const rendered = browser.grouped ? sections.flatMap(section => section.data) : view.flatSessions;
  const firstPathId = rendered.find(opensAgentTranscript)?.id;

  const renderGrouped = useCallback(
    ({ item }: { item: BrowserSession }) => (
      <SessionRow
        session={item}
        showCwd={false}
        firstPathOpen={item.id === firstPathId}
        onOpen={onOpen}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={onDelete}
        deleteAccess={deleteAccess}
        now={now}
      />
    ),
    [firstPathId, onOpen, onArchive, onUnarchive, onDelete, deleteAccess, now],
  );

  const renderFlat = useCallback(
    ({ item }: { item: BrowserSession }) => (
      <SessionRow
        session={item}
        showCwd
        firstPathOpen={item.id === firstPathId}
        onOpen={onOpen}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={onDelete}
        deleteAccess={deleteAccess}
        now={now}
      />
    ),
    [firstPathId, onOpen, onArchive, onUnarchive, onDelete, deleteAccess, now],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: { cwd: string; group: SessionGroup } }) => (
      <GroupHeader
        group={section.group}
        collapsed={browser.collapsedGroups.has(section.cwd)}
        onToggle={onToggleGroup}
      />
    ),
    [browser.collapsedGroups, onToggleGroup],
  );

  return (
    <View style={styles.screen} testID="fleet">
      <View style={styles.head}>
        <View style={styles.lead}>
          <Glyph name="bay" size={16} color={ink.plain} />
          <Display heading testID="fleet-title">
            Sessions
          </Display>
          <Kicker color={ink.muted} testID="fleet-count">
            {`${view.visibleCount} ${view.visibleCount === 1 ? "session" : "sessions"}`}
          </Kicker>
        </View>
        <Pressable
          testID="grouped-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: browser.grouped }}
          accessibilityLabel={browser.grouped ? "Grouped by directory" : "Flat list"}
          onPress={onToggleGrouped}
          style={toggleStyle}
        >
          <Glyph name="folder" size={12} color={browser.grouped ? signal.amber : ink.faint} />
        </Pressable>
        <Pressable
          testID="archived-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: browser.showArchived }}
          accessibilityLabel={
            browser.showArchived
              ? "Hide archived sessions"
              : `Show ${view.hiddenArchived} archived ${view.hiddenArchived === 1 ? "session" : "sessions"}`
          }
          onPress={onToggleArchived}
          style={toggleStyle}
        >
          <Glyph name="archive" size={12} color={browser.showArchived ? signal.amber : ink.faint} />
          {!browser.showArchived && view.hiddenArchived > 0 ? (
            <Label color={ink.faint} testID="archived-hidden-count">
              {view.hiddenArchived}
            </Label>
          ) : null}
        </Pressable>
      </View>

      {deleteAccess === "missing" ? (
        // A band in the column, never a layer over it: see
        // `test/no-hidden-content.test.ts` for why nothing here floats.
        <View style={styles.scopeNotice} testID="fleet-delete-scope-notice">
          <Glyph name="warning" size={12} color={signal.ochre} />
          <Label color={signal.ochre} style={styles.scopeNoticeText}>
            This pairing can archive but not delete: it holds no manage scope. Grant manage when minting this
            device&rsquo;s credential, from the daemon or from a device that can invite.
          </Label>
        </View>
      ) : null}

      <SortBar sort={browser.sort} onChange={onSort} />

      {browser.grouped ? (
        <SectionList
          testID="fleet-list"
          sections={sections}
          keyExtractor={keyOf}
          renderSectionHeader={renderSectionHeader}
          renderItem={renderGrouped}
          stickySectionHeadersEnabled
          initialNumToRender={FIRST_WINDOW}
          maxToRenderPerBatch={FIRST_WINDOW}
          windowSize={WINDOW_SIZE}
          updateCellsBatchingPeriod={BATCH_PERIOD_MS}
          ListEmptyComponent={EMPTY}
        />
      ) : (
        <FlatList
          testID="fleet-list"
          data={view.flatSessions as BrowserSession[]}
          keyExtractor={keyOf}
          renderItem={renderFlat}
          initialNumToRender={FIRST_WINDOW}
          maxToRenderPerBatch={FIRST_WINDOW}
          windowSize={WINDOW_SIZE}
          updateCellsBatchingPeriod={BATCH_PERIOD_MS}
          ListEmptyComponent={EMPTY}
        />
      )}
    </View>
  );
}

function Empty(): JSX.Element {
  return (
    <View style={styles.empty} testID="fleet-empty">
      <Glyph name="bay" size={26} color={ground.edge} />
      <Body color={ink.plain}>No sessions.</Body>
      <Label color={ink.muted}>Start one with ompd agents create on the machine running the daemon.</Label>
    </View>
  );
}

const toggleStyle = ({ pressed }: PressableStateCallbackType) => [styles.toggle, pressed && styles.togglePressed];

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  // The title block absorbs the header's slack, so the two controls after it
  // sit at the trailing content edge, flush with the action columns of the
  // rows below. With this group owning the slack, the head's gap is the only
  // spacing mechanism left in the strip, which is why `toggle` adds no margin
  // of its own.
  lead: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    justifyContent: "center",
  },
  togglePressed: { backgroundColor: ground.active },
  scopeNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.tight,
    paddingHorizontal: space.wide,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  // Shrinkable, so the sentence wraps inside the band instead of running out
  // of it and under whatever draws next.
  scopeNoticeText: { flex: 1, minWidth: 0 },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
});
