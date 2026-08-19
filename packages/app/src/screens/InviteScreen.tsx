/**
 * Mint a second device's credential and hand it over as a QR code.
 *
 * This screen is the app playing the role `ompd approve` plays on the
 * daemon's own machine: it spends this device's own `approve` scope to grant
 * a new device a token, then shows that token as a code the new device scans
 * -- never as a link. `core/src/pairing.ts` explains why a `PairingBundle`
 * carrying a bearer token must never become a URL; this screen is the other
 * half of that contract, the one that mints the bundle in the first place.
 *
 * The mint rides the socket this connection already holds, for every
 * transport. A hub relay carries one sealed websocket and no daemon HTTP, so
 * the two-request HTTP flow (`POST /v1/pair`, then `POST /v1/pairings/approve`)
 * could only ever work from the daemon's own network; one `device_invite`
 * frame replaces both steps and works from anywhere the app is already
 * connected. The daemon, not this screen, enforces the ceiling: the picker
 * starts at this device's own scopes, widening past them is still possible
 * because the operator may legitimately want a different grant, and a
 * widened ask comes back as a readable refusal rather than a quieter grant.
 */

import { SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { PairedConnection } from "@ompd/core/pairing";
import { encodePairingBundle } from "@ompd/core/pairing";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { createOmpdClient } from "../console/useConsole.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

/** Every scope the daemon knows how to grant. Mirrors the gateway's own `KNOWN_SCOPES`, which is not exported. */
const ALL_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_APPROVE, SCOPE_MANAGE];

type Status =
  | { kind: "pending" }
  | { kind: "minting" }
  | { kind: "ready"; encoded: string; label: string }
  | { kind: "error"; message: string };

/** The QR payload for a mint: the connection this device already holds, carrying the fresh token. */
export function bundleForInvite(
  connection: Connection,
  token: string,
  scopes: readonly string[],
  label: string,
): string {
  const paired: PairedConnection =
    connection.transport === "direct"
      ? { transport: "direct", url: connection.url, token, scopes: [...scopes] }
      : { transport: "hub", hubUrl: connection.hubUrl, daemonId: connection.daemonId, token, scopes: [...scopes] };
  return encodePairingBundle({ v: 1, label, connection: paired });
}

export function InviteScreen({
  connection,
  onDone,
  createClient = createOmpdClient,
}: {
  connection: Connection;
  onDone: () => void;
  /** Seam for tests: builds the socket client the mint rides. */
  createClient?: (connection: Connection) => OmpdClient;
}): JSX.Element {
  const [name, setName] = useState("New device");
  const [scopes, setScopes] = useState<Set<string>>(() => new Set(connection.scopes));
  const [status, setStatus] = useState<Status>({ kind: "pending" });

  // One client for this screen's lifetime. A client per render would be a
  // reconnect loop wearing a daemon's face; this is the same rule
  // `useConsole` applies to the Console's own socket.
  const clientRef = useRef<OmpdClient | null>(null);
  if (clientRef.current === null) clientRef.current = createClient(connection);
  const client = clientRef.current;

  // The ask travels by reference, not closure: the socket comes up after
  // mount, by which time the operator may have edited the name or toggled a
  // scope, and the frame must carry what the fields hold at that moment.
  const askRef = useRef({ name: "New device", scopes: new Set(connection.scopes) });
  askRef.current = { name, scopes };

  // Whether the mount-time mint has been sent. The answer settles only once
  // per press of Generate; a reconnect must not mint again on its own,
  // because a credential minted twice is two credentials.
  const askedRef = useRef(false);
  // Whether a QR is currently on screen. A link error after a successful
  // mint does not un-mint it: the token exists and the code is good, and
  // tearing it down over a ping timeout would tell the operator to redo an
  // act that already succeeded. Cleared the moment they ask again, because
  // then they are waiting on an answer and a swallowed refusal is a spinner
  // that never resolves.
  const settledRef = useRef(false);

  useEffect(() => {
    const offs = [
      client.on("status", event => {
        if (event.state !== "connected" || askedRef.current) return;
        askedRef.current = true;
        setStatus({ kind: "minting" });
        client.inviteDevice(askRef.current.name, [...askRef.current.scopes]);
      }),
      client.on("device_invited", event => {
        settledRef.current = true;
        setStatus({
          kind: "ready",
          encoded: bundleForInvite(connection, event.token, event.scopes, event.name),
          label: event.name,
        });
      }),
      client.on("error", event => {
        if (settledRef.current) return;
        setStatus({ kind: "error", message: event.message });
      }),
    ];
    client.start();
    return () => {
      for (const off of offs) off();
      client.close();
    };
  }, [client, connection]);

  const generate = useCallback(() => {
    settledRef.current = false;
    setStatus({ kind: "minting" });
    client.inviteDevice(name, [...scopes]);
  }, [client, name, scopes]);

  const toggleScope = useCallback((scope: string) => {
    setScopes(current => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }, []);

  return (
    <SafeScreen style={styles.screen} testID="invite">
      <View style={styles.header}>
        <Kicker color={ink.muted}>ompctl</Kicker>
        <Display heading>Invite a device</Display>
        <Body color={ink.plain}>
          Generates a code for one new device. Scan it there to pair; the code is only good once.
        </Body>
      </View>

      <View style={styles.field}>
        <Kicker color={ink.muted}>Device name</Kicker>
        <TextInput
          accessibilityLabel="Device name"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setName}
          spellCheck={false}
          style={[styles.input, type.code]}
          testID="invite-name"
          value={name}
        />
      </View>

      <View style={styles.field}>
        <Kicker color={ink.muted}>Scopes</Kicker>
        <View style={styles.scopes}>
          {ALL_SCOPES.map(scope => {
            const checked = scopes.has(scope);
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                key={scope}
                onPress={() => toggleScope(scope)}
                style={[styles.scope, checked && styles.scopeChecked]}
                testID={`invite-scope-${scope}`}
              >
                <Label color={checked ? signal.sage : ink.plain}>{scope}</Label>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Pressable accessibilityRole="button" onPress={generate} style={styles.generate} testID="invite-generate">
        <Label color={signal.sage}>Generate</Label>
      </Pressable>

      <View style={styles.result} testID="invite-result">
        {status.kind === "pending" || status.kind === "minting" ? (
          <View style={styles.centered}>
            <ActivityIndicator color={ink.plain} />
          </View>
        ) : status.kind === "error" ? (
          <View style={styles.notice} testID="invite-error">
            <Label color={signal.ochre} style={styles.noticeText}>
              {status.message}
            </Label>
          </View>
        ) : (
          <View style={styles.qr} testID="invite-qr">
            <QRCode size={220} value={status.encoded} />
            <Label color={ink.plain}>{status.label}</Label>
          </View>
        )}
      </View>

      <Pressable accessibilityRole="button" onPress={onDone} style={styles.done} testID="invite-done">
        <Label color={ink.bright}>Done</Label>
      </Pressable>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, gap: space.step, padding: space.loose },
  header: { gap: space.tight },
  field: { gap: space.tight },
  input: {
    backgroundColor: ground.surface,
    borderColor: ground.line,
    borderWidth: stroke.hair,
    color: ink.bright,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  scopes: { flexDirection: "row", flexWrap: "wrap", gap: space.snug },
  scope: {
    alignItems: "center",
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  scopeChecked: { borderColor: signal.sage },
  generate: {
    alignItems: "center",
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
  },
  result: { alignItems: "center", flex: 1, justifyContent: "center" },
  centered: { alignItems: "center", justifyContent: "center" },
  notice: {
    backgroundColor: signalWash.ochre,
    borderLeftColor: signal.ochre,
    borderLeftWidth: stroke.heavy,
    padding: space.step,
  },
  noticeText: { flex: 1 },
  qr: { alignItems: "center", gap: space.step },
  done: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
});
