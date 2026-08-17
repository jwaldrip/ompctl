/**
 * The web counterpart of the QR scanner.
 *
 * `react-native-vision-camera` is a native module: its entry imports
 * `requireNativeComponent`, which react-native-web does not implement, so merely
 * having the native screen in the module graph fails the web build outright
 * rather than degrading. This file exists so the browser bundle never reaches it.
 *
 * The screen renders the same "no usable camera" state the native screen already
 * shows when a device has no back camera, under the same `scan-no-device`
 * testID. That keeps one behaviour, one testID, and one feature file across
 * platforms instead of a web-only dialect.
 *
 * Deliberately not a browser `getUserMedia` scanner: pairing hands a bearer
 * token to a daemon that runs code as the operator, and the manual field on the
 * pair screen is already the honest path on a machine where the daemon is
 * usually the same machine. A half-working camera here would be a worse promise
 * than none.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, TOUCH_TARGET } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

export function ScanScreen({
  onCancel,
}: {
  onCancel: () => void;
  // Accepted so the web and native screens share one call signature, even though
  // nothing here can produce a scan.
  onScanned: (connection: Connection, label: string) => void;
}): JSX.Element {
  return (
    <SafeScreen style={styles.screen} testID="scan">
      <View style={styles.header}>
        <Kicker color={ink.faint}>ompctl</Kicker>
        <Display color={ink.bright} heading>
          Scan to pair
        </Display>
      </View>

      <View style={styles.centered} testID="scan-no-device">
        <Glyph color={signal.ochre} name="unpair" size={12} />
        <Body color={ink.bright}>Scanning needs the camera on a phone or tablet.</Body>
        <Label color={ink.muted}>Paste the endpoint and token instead.</Label>
      </View>

      <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel} testID="scan-cancel">
        <Label color={ink.plain}>Back to manual entry</Label>
      </Pressable>
    </SafeScreen>
  );
}

// Mirrors the native screen's scale exactly, using the token names that exist.
const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, justifyContent: "space-between" },
  header: { gap: space.tight, padding: space.loose },
  centered: { alignItems: "center", flex: 1, gap: space.step, justifyContent: "center", padding: space.loose },
  cancel: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET, padding: space.step },
});
