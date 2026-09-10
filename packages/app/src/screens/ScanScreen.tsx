/**
 * Read a `PairingBundle` off a QR code instead of copying one by hand.
 *
 * A scan is not a pairing. `parsePairingBundle` runs on whatever the camera
 * decoded -- a stranger's QR code left on a desk, a screenshot of someone
 * else's bundle, a code from a different app entirely -- and most of what it
 * sees back is foreign or malformed. That case stays quiet and keeps
 * scanning rather than treating a decode as consent. A bundle that *does*
 * parse still stops short of `onScanned`: the daemon's own pairing docs
 * (`docs/hub.md`, `core/src/pairing.ts`) draw the line at a deliberate
 * approval decision, and a phone auto-saving the instant a camera resolves a
 * code would spend that decision on a glance rather than a choice. The
 * confirmation card between "scanned" and "saved" is that choice.
 */

import { parseDeviceCredential, parsePairingBundle } from "@ompd/core/pairing";
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { CameraSeam, Code } from "../platform/camera";
import { cameraSeam, createCameraSeam } from "../platform/camera";
import type { Connection } from "../platform/connection.ts";
import { parsePairDeepLink } from "../platform/deeplink.ts";

export function ScanScreen({
  onCancel,
  onScanned,
  camera = cameraSeam,
}: {
  onCancel: () => void;
  onScanned: (connection: Connection, label: string) => void;
  camera?: CameraSeam;
}): JSX.Element {
  const [loadedCamera, setLoadedCamera] = useState<CameraSeam | null>(() => {
    if (camera.Camera !== undefined && camera.hooks !== undefined) return camera;
    return null;
  });

  useEffect(() => {
    if (!camera.availability.available || loadedCamera !== null) return;
    let active = true;
    if (camera.loadModule) {
      void camera.loadModule().then(rawModule => {
        if (active && rawModule) {
          setLoadedCamera(createCameraSeam(rawModule));
        }
      });
    }
    return () => {
      active = false;
    };
  }, [camera, loadedCamera]);

  if (!camera.availability.available) {
    return (
      <SafeScreen style={styles.screen} testID="scan">
        <View style={styles.header}>
          <Kicker color={ink.faint}>ompctl</Kicker>
          <Display color={ink.bright} heading>
            Scan to pair
          </Display>
        </View>

        <View style={styles.centered} testID="scan-no-device">
          <Glyph color={signal.holding} name="unpair" size={12} />
          <Body color={ink.bright}>{camera.availability.reason}</Body>
          <Label color={ink.muted}>Paste the endpoint and token instead.</Label>
        </View>

        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel} testID="scan-cancel">
          <Label color={ink.plain}>Back to manual entry</Label>
        </Pressable>
      </SafeScreen>
    );
  }

  const activeCamera = loadedCamera ?? (camera.Camera !== undefined && camera.hooks !== undefined ? camera : null);
  if (activeCamera === null || activeCamera.Camera === undefined || activeCamera.hooks === undefined) {
    return (
      <SafeScreen style={styles.screen} testID="scan">
        <View />
      </SafeScreen>
    );
  }

  return (
    <LiveScanScreen Camera={activeCamera.Camera} hooks={activeCamera.hooks} onCancel={onCancel} onScanned={onScanned} />
  );
}

function LiveScanScreen({
  Camera,
  hooks,
  onCancel,
  onScanned,
}: {
  Camera: NonNullable<CameraSeam["Camera"]>;
  hooks: NonNullable<CameraSeam["hooks"]>;
  onCancel: () => void;
  onScanned: (connection: Connection, label: string) => void;
}): JSX.Element {
  const { hasPermission, requestPermission } = hooks.useCameraPermission();
  const device = hooks.useCameraDevice("back");
  const [invalid, setInvalid] = useState(false);
  // Set once a decode parses, cleared on cancel: the camera keeps running
  // underneath so declining a mistaken scan costs nothing.
  const [pending, setPending] = useState<{ connection: Connection; label: string } | null>(null);

  const handleCode = useCallback((codes: Code[]) => {
    const raw = codes[0]?.value;
    if (raw === undefined) return;
    const bundle = parsePairingBundle(raw);
    if (bundle !== null) {
      setInvalid(false);
      const conn = bundle.connection;
      const cred = conn.transport === "hub" ? parseDeviceCredential(conn.token) : null;
      const connection: Connection =
        conn.transport === "hub" && cred !== null ? { ...conn, token: cred.token, daemonId: cred.daemonId } : conn;
      setPending({ connection, label: bundle.label });
      return;
    }
    const deepLink = parsePairDeepLink(raw);
    if (deepLink !== null) {
      setInvalid(false);
      setPending({
        connection: {
          transport: "hub",
          hubUrl: deepLink.hubUrl,
          daemonId: deepLink.daemonId,
          token: deepLink.token,
          scopes: [...deepLink.scopes],
        },
        label: "Scanned device",
      });
      return;
    }
    setInvalid(true);
  }, []);

  const codeScanner = hooks.useCodeScanner({
    codeTypes: ["qr"],
    onCodeScanned: handleCode,
  });
  return (
    <SafeScreen style={styles.screen} testID="scan">
      <View style={styles.header}>
        <Kicker color={ink.faint}>ompctl</Kicker>
        <Display color={ink.bright} heading>
          Scan to pair
        </Display>
        <Body color={ink.bright}>Point the camera at the QR code an approved device is showing.</Body>
      </View>

      {!hasPermission ? (
        <View style={styles.centered} testID="scan-permission">
          <Body color={ink.bright}>ompctl needs the camera to read a pairing code.</Body>
          <Pressable
            accessibilityRole="button"
            onPress={() => void requestPermission()}
            style={styles.action}
            testID="scan-request-permission"
          >
            <Label color={signal.ready}>Allow camera access</Label>
          </Pressable>
        </View>
      ) : device === undefined ? (
        <View style={styles.centered} testID="scan-no-device">
          <Body color={ink.bright}>No usable camera was found on this device.</Body>
        </View>
      ) : (
        <>
          <Camera
            codeScanner={codeScanner}
            device={device}
            isActive={pending === null}
            style={StyleSheet.absoluteFill}
            testID="scan-camera"
          />
          {invalid && pending === null ? (
            <View style={styles.notice} testID="scan-invalid">
              <Glyph color={signal.holding} name="unpair" size={12} />
              <Label color={signal.holding} style={styles.noticeText}>
                That code isn't an ompd pairing code.
              </Label>
            </View>
          ) : null}
        </>
      )}

      {pending === null ? null : (
        <View style={styles.confirm} testID="scan-confirm">
          <Body color={ink.bright}>Pair with {pending.label}?</Body>
          <View style={styles.confirmRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPending(null)}
              style={styles.confirmCancel}
              testID="scan-confirm-cancel"
            >
              <Label color={ink.plain}>Not this one</Label>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => onScanned(pending.connection, pending.label)}
              style={styles.confirmAccept}
              testID="scan-confirm-accept"
            >
              <Label color={signal.ready}>Pair</Label>
            </Pressable>
          </View>
        </View>
      )}

      <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel} testID="scan-cancel">
        <Label color={ink.plain}>Back to manual entry</Label>
      </Pressable>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: ground.base, justifyContent: "space-between" },
  header: { gap: space.tight, padding: space.loose },
  centered: { alignItems: "center", flex: 1, gap: space.step, justifyContent: "center", padding: space.loose },
  action: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET, paddingHorizontal: space.wide },
  notice: {
    alignItems: "center",
    backgroundColor: signalWash.holding,
    borderLeftColor: signal.holding,
    borderLeftWidth: stroke.heavy,
    flexDirection: "row",
    gap: space.snug,
    margin: space.loose,
    padding: space.step,
  },
  noticeText: { flex: 1 },
  confirm: {
    backgroundColor: ground.raised,
    borderTopColor: ground.edge,
    borderTopWidth: stroke.hair,
    gap: space.step,
    padding: space.loose,
  },
  confirmRow: { flexDirection: "row", gap: space.step },
  confirmCancel: { alignItems: "center", flex: 1, justifyContent: "center", minHeight: TOUCH_TARGET },
  confirmAccept: {
    alignItems: "center",
    borderColor: signal.ready,
    borderWidth: stroke.hair,
    flex: 1,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
  },
  cancel: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET, padding: space.step },
});
