/**
 * The daemon's own settings: its policy posture and whether it keeps its host
 * awake, read and changed over the socket this connection already holds.
 *
 * The ask rides the client rather than HTTP on purpose. The hub tunnels
 * exactly one request shape today, a webhook fire, and no tunnel is wired for
 * `GET /v1/sync-settings`, so a phone paired through the hub has no road to
 * that route at all. Wiring a general one is the road not taken, and not
 * because the hub could not carry it: a proxied read would put this device's
 * bearer token in the hub's hands, and the hub is meant to carry sealed
 * traffic it cannot read. `readSettings` and `writeSettings` hide that
 * choice, and this screen only knows that it asked, was answered, or was
 * refused by name.
 *
 * Confirmed state is rendered, never intent. The daemon answers a write with
 * what it reads back after applying, so a tapped option shows as current only
 * once the machine under it changed; a refused write leaves the last
 * confirmed truth on screen beside a line that names what went wrong.
 *
 * Scope honesty: most pairings hold no `manage`, and a settings screen that
 * went blank or spun forever for them would be exactly the silent refusal
 * this surface exists to end. A manage-less pairing still reads and renders,
 * with the controls off and the missing scope named.
 */

import type { PolicyMode, SyncSettings } from "@ompd/core/contracts";
import { SCOPE_MANAGE } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { createOmpdClient } from "../console/useConsole.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

/**
 * What each posture governs, in the daemon's own terms: these lines restate
 * `PolicyConfig.mode` in the contracts, because `strict`, `standard`, and
 * `trusted` are jargon on a phone and a wrong guess here widens what an
 * operator believes they allowed.
 */
const POLICY_OPTIONS: ReadonlyArray<{ mode: PolicyMode; name: string; governs: string }> = [
  { mode: "strict", name: "Strict", governs: "Asks before every write and every command." },
  {
    mode: "standard",
    name: "Standard",
    governs: "Writes inside the workspace run on their own; everything else asks.",
  },
  {
    mode: "trusted",
    name: "Trusted",
    governs: "Commands run on their own too, except critical ones, which still ask.",
  },
];

/**
 * `write-failed` carries the settings it failed to replace under the same
 * `settings` field `ready` uses: the daemon's truth did not change, so the
 * values on screen must not either, only the line saying the save was
 * refused.
 */
type SettingsStatus =
  | { kind: "loading" }
  | { kind: "read-failed"; message: string }
  | { kind: "ready"; settings: SyncSettings }
  | { kind: "write-failed"; message: string; attempted: SyncSettings; settings: SyncSettings };

export function SettingsScreen({
  connection,
  onBack,
  createClient = createOmpdClient,
}: {
  connection: Connection;
  onBack: () => void;
  /** Seam for tests: builds the socket client the settings ride. */
  createClient?: (connection: Connection) => OmpdClient;
}): JSX.Element {
  // Most pairings watch; the screen decides from the pairing's own grant
  // rather than asking and failing, because the pairing row is the truth a
  // person can act on and the daemon's refusal only re-states it.
  const canManage = connection.scopes.includes(SCOPE_MANAGE);
  const [status, setStatus] = useState<SettingsStatus>({ kind: "loading" });
  const [writing, setWriting] = useState(false);

  // One client for this screen's lifetime. A client per render would be a
  // reconnect loop wearing a daemon's face; this is the same rule
  // `useConsole` applies to the Console's own socket.
  const clientRef = useRef<OmpdClient | null>(null);
  if (clientRef.current === null) clientRef.current = createClient(connection);
  const client = clientRef.current;

  // The listeners outlive renders, so what they need to know travels by
  // reference: whether a read or write is still owed an answer, and what a
  // retry of a failed write should send.
  const readPendingRef = useRef(true);
  const writingRef = useRef(false);
  const attemptedRef = useRef<SyncSettings | null>(null);
  const confirmedRef = useRef<SyncSettings | null>(null);

  useEffect(() => {
    const offs = [
      client.on("status", event => {
        if (event.state !== "connected" || !readPendingRef.current) return;
        client.readSettings();
      }),
      client.on("settings", event => {
        readPendingRef.current = false;
        writingRef.current = false;
        confirmedRef.current = event.settings;
        setWriting(false);
        setStatus({ kind: "ready", settings: event.settings });
      }),
      client.on("error", event => {
        // Only an answer owed to this screen's own ask is its failure to
        // report; anything else is socket traffic this surface did not cause.
        if (writingRef.current) {
          const attempted = attemptedRef.current;
          const confirmed = confirmedRef.current;
          writingRef.current = false;
          setWriting(false);
          if (attempted !== null && confirmed !== null) {
            setStatus({ kind: "write-failed", message: event.message, attempted, settings: confirmed });
          } else {
            // A write with no remembered pair to retry is reported as a read
            // failure instead, so the honest remedy is a fresh read rather
            // than a resend nobody can name.
            readPendingRef.current = true;
            setStatus({ kind: "read-failed", message: event.message });
          }
          return;
        }
        if (!readPendingRef.current) return;
        setStatus({ kind: "read-failed", message: event.message });
      }),
    ];
    client.start();
    return () => {
      for (const off of offs) off();
      client.close();
    };
  }, [client]);

  const retryRead = useCallback(() => {
    readPendingRef.current = true;
    setStatus({ kind: "loading" });
    client.readSettings();
  }, [client]);

  const retryWrite = useCallback(() => {
    const attempted = attemptedRef.current;
    if (attempted === null) return;
    writingRef.current = true;
    setWriting(true);
    client.writeSettings(attempted);
  }, [client]);

  const changeSettings = useCallback(
    (next: SyncSettings) => {
      if (!canManage || writingRef.current) return;
      writingRef.current = true;
      attemptedRef.current = next;
      setWriting(true);
      client.writeSettings(next);
    },
    [canManage, client],
  );

  // Both states that reach the controls carry `settings`, narrowed here once
  // so the rows below read one name for the daemon's confirmed truth.
  const shown = status.kind === "ready" || status.kind === "write-failed" ? status.settings : null;

  const choosePolicy = useCallback(
    (mode: PolicyMode) => {
      if (shown === null) return;
      if (shown.policyMode === mode) return;
      changeSettings({ policyMode: mode, keepAwake: shown.keepAwake });
    },
    [changeSettings, shown],
  );

  const toggleKeepAwake = useCallback(() => {
    if (shown === null) return;
    changeSettings({ policyMode: shown.policyMode, keepAwake: !shown.keepAwake });
  }, [changeSettings, shown]);

  return (
    <SafeScreen style={styles.screen} testID="daemon-settings">
      <View style={styles.header}>
        <Kicker color={ink.muted}>Daemon</Kicker>
        <Display heading>Settings</Display>
        <Body color={ink.plain}>What this daemon may do without asking, and whether it keeps its Mac awake.</Body>
      </View>

      {status.kind === "loading" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={ink.plain} />
        </View>
      ) : status.kind === "read-failed" ? (
        <View style={styles.notice} testID="settings-read-error">
          <Label color={signal.ochre} style={styles.noticeText}>
            Could not read the daemon&rsquo;s settings: {status.message}
          </Label>
          <Pressable accessibilityRole="button" onPress={retryRead} style={styles.retry} testID="settings-retry-read">
            <Label color={signal.sage}>Try again</Label>
          </Pressable>
        </View>
      ) : shown === null ? null : (
        <>
          {canManage ? null : (
            <View style={styles.notice} testID="settings-readonly-notice">
              <Label color={signal.ochre} style={styles.noticeText}>
                This pairing can watch but not change: it holds no manage scope. Grant manage when minting this
                device&rsquo;s credential, from the daemon or from a device that can invite.
              </Label>
            </View>
          )}

          {status.kind === "write-failed" ? (
            <View style={styles.notice} testID="settings-write-error">
              <Label color={signal.oxide} style={styles.noticeText}>
                Could not save: {status.message}
              </Label>
              <Pressable
                accessibilityRole="button"
                onPress={retryWrite}
                style={styles.retry}
                testID="settings-retry-write"
              >
                <Label color={signal.sage}>Try again</Label>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.section}>
            <Kicker color={ink.muted}>Policy</Kicker>
            <View accessibilityRole="radiogroup" style={styles.options}>
              {POLICY_OPTIONS.map(option => {
                const current = shown.policyMode === option.mode;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: current }}
                    disabled={!canManage || writing}
                    key={option.mode}
                    onPress={() => choosePolicy(option.mode)}
                    style={[styles.option, current && styles.optionCurrent]}
                    testID={`settings-policy-${option.mode}`}
                  >
                    <View style={styles.optionCopy}>
                      <Label color={current ? signal.sage : ink.plain}>{option.name}</Label>
                      <Body color={ink.muted}>{option.governs}</Body>
                    </View>
                    {current ? (
                      <Label color={signal.sage} testID={`settings-policy-${option.mode}-current`}>
                        Current
                      </Label>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Kicker color={ink.muted}>Keep awake</Kicker>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: shown.keepAwake }}
              disabled={!canManage || writing}
              onPress={toggleKeepAwake}
              style={styles.option}
              testID="settings-keepawake"
            >
              <View style={styles.optionCopy}>
                <Body color={ink.plain}>
                  Keeps the daemon&rsquo;s Mac awake while agents run, so long turns do not pause on sleep.
                </Body>
              </View>
              <Label
                color={shown.keepAwake ? signal.sage : ink.muted}
                testID={shown.keepAwake ? "settings-keepawake-on" : "settings-keepawake-off"}
              >
                {shown.keepAwake ? "On" : "Off"}
              </Label>
            </Pressable>
          </View>

          <Body color={ink.faint}>
            Changes persist immediately. The running daemon picks up policy and its sleep guard the next time it
            restarts.
          </Body>
        </>
      )}

      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back} testID="settings-back">
        <Label color={ink.bright}>Back</Label>
      </Pressable>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, gap: space.loose, padding: space.wide },
  header: { gap: space.snug },
  centered: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
  notice: {
    backgroundColor: ground.raised,
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    gap: space.step,
    padding: space.wide,
  },
  noticeText: { ...type.body, lineHeight: 20 },
  retry: { alignItems: "flex-start", justifyContent: "center", minHeight: TOUCH_TARGET },
  section: { gap: space.step },
  options: { gap: space.tight },
  option: {
    alignItems: "center",
    backgroundColor: ground.surface,
    borderBottomColor: ground.line,
    borderBottomWidth: stroke.hair,
    flexDirection: "row",
    gap: space.step,
    minHeight: TOUCH_TARGET,
    padding: space.wide,
  },
  optionCurrent: { backgroundColor: ground.active },
  optionCopy: { flex: 1, gap: space.tight },
  back: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
});
