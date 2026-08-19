/**
 * Where a device gets its credential.
 *
 * `notice` explains why the operator is looking at this screen again rather
 * than at their agents. A pairing form with no explanation, after a console
 * that was working a second ago, reads as the app having lost its mind.
 *
 * There is no prefilled endpoint. `ws://127.0.0.1` used to sit here as a
 * starting point, and on a phone loopback is the phone: it looked like an
 * answer and was never one. The daemon is the only thing that knows its own
 * address, so this screen asks for exactly what `ompd approve` prints rather
 * than guessing at it.
 */

import { DEFAULT_HUB_HOST, parseDeviceCredential, parsePairTarget } from "@ompd/core/pairing";
import type { JSX } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { useFormMaxWidth } from "../design/layout.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

export function PairScreen({
  notice,
  onCancel,
  onPair,
  onScan,
}: {
  notice?: string;
  onCancel?: () => void;
  onPair: (connection: Connection) => void;
  /**
   * Opens the camera. A route rather than a boolean here: the scan surface has
   * a back gesture, a place in the navigation state, and a way to be reached
   * from anywhere, none of which a flag inside this form could give it.
   */
  onScan: () => void;
}): JSX.Element {
  const [raw, setRaw] = useState(DEFAULT_HUB_HOST);
  const [token, setToken] = useState("");
  const { width } = useWindowDimensions();
  const formMaxWidth = useFormMaxWidth();
  const target = parsePairTarget(raw);
  // The daemon travels inside the credential, so the token field is what
  // decides whether this form can produce a hub connection at all.
  const credential = parseDeviceCredential(token);
  const ready = target !== null && (target.transport === "direct" ? token.trim().length > 0 : credential !== null);

  return (
    <SafeScreen style={styles.screen} testID="pair">
      <View style={width > formMaxWidth ? [styles.form, { maxWidth: formMaxWidth }] : styles.form} testID="pair-form">
        <Kicker color={ink.muted}>ompctl</Kicker>
        <Display heading>Take the position</Display>

        {notice === undefined ? null : (
          <View style={styles.notice} accessibilityLiveRegion="assertive" testID="pair-notice">
            <Glyph name="unpair" size={12} color={signal.ochre} />
            <Label color={signal.ochre} style={styles.noticeText}>
              {notice}
            </Label>
          </View>
        )}

        <Body color={ink.plain}>
          On the machine running the daemon: ompd invite for a token. Paste it below. The hub is already filled in;
          change it only if you run your own.
        </Body>

        <Pressable accessibilityRole="button" onPress={onScan} style={styles.scanEntry} testID="pair-scan-entry">
          <Glyph color={ink.plain} name="qrcode" size={14} />
          <Label color={ink.plain}>Scan a QR code instead</Label>
        </Pressable>

        <Field label="Hub" value={raw} onChange={setRaw} testID="pair-endpoint" />
        {raw.trim().length === 0 ? null : (
          <Label color={target === null ? signal.ochre : ink.muted} testID="pair-endpoint-kind">
            {target === null
              ? "Not a hub address"
              : // A hub base and a daemon's own socket read alike, so the
                // transport is named back: one reaches a daemon behind NAT, the
                // other only works on this network.
                target.transport === "direct"
                ? "Direct socket"
                : target.hubUrl}
          </Label>
        )}
        <Field label="Token" value={token} onChange={setToken} secure testID="pair-token" />
        {token.trim().length === 0 || target?.transport === "direct" ? null : (
          <Label color={credential === null ? signal.ochre : ink.muted} testID="pair-token-kind">
            {credential === null ? "Not a device token" : `Daemon ${credential.daemonId.slice(0, 11)}...`}
          </Label>
        )}

        <Pressable
          testID="pair-submit"
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => {
            if (target === null) return;
            const trimmedToken = token.trim();
            if (target.transport === "direct") {
              onPair({ transport: "direct", url: target.url, token: trimmedToken, scopes: [] });
              return;
            }
            if (credential === null) return;
            onPair({
              transport: "hub",
              hubUrl: target.hubUrl,
              daemonId: credential.daemonId,
              token: credential.token,
              scopes: [],
            });
          }}
          style={({ pressed }) => [
            styles.submit,
            { borderColor: ready ? signal.sage : ground.edge },
            pressed && { backgroundColor: ground.active },
          ]}
        >
          <Label color={ready ? signal.sage : ink.faint}>Connect</Label>
        </Pressable>
        {onCancel === undefined ? null : (
          <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel} testID="pair-cancel">
            <Label color={ink.plain}>Back to connections</Label>
          </Pressable>
        )}
      </View>
    </SafeScreen>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  testID,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  secure?: boolean;
  testID: string;
}): JSX.Element {
  return (
    <View style={styles.field}>
      <Kicker color={ink.muted}>{label}</Kicker>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        style={[styles.input, type.code]}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure === true}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { justifyContent: "center", padding: space.loose },
  form: { gap: space.step, width: "100%", alignSelf: "center" },
  notice: {
    flexDirection: "row",
    gap: space.snug,
    padding: space.step,
    backgroundColor: signalWash.ochre,
    borderLeftWidth: stroke.heavy,
    borderLeftColor: signal.ochre,
  },
  noticeText: { flex: 1 },
  field: { gap: space.tight },
  input: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    color: ink.bright,
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  submit: {
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hair,
    marginTop: space.snug,
  },
  cancel: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET },
  scanEntry: { alignItems: "center", flexDirection: "row", gap: space.snug, minHeight: TOUCH_TARGET },
});
