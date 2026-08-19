/**
 * The navigator, in this app's own materials.
 *
 * React Navigation ships a light theme and a dark one, and neither is this:
 * the app is warm graphite with Archivo, and a stock header would read as a
 * different application bolted on top. So the theme and the shared screen
 * options are built from the same tokens every surface draws from, once, here,
 * rather than per navigator.
 *
 * The header is not decoration in this app. It is the only thing that clears
 * the status bar on every route that does not draw its own top bar, which is
 * why its colours live beside the insets logic in `SafeScreen` rather than
 * inside a screen.
 */

import type { Theme } from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { face, ground, ink, signal, type } from "../design/tokens.ts";

export const SHELL_THEME: Theme = {
  dark: true,
  colors: {
    primary: signal.amber,
    background: ground.base,
    card: ground.raised,
    text: ink.bright,
    border: ground.edge,
    notification: signal.oxide,
  },
  fonts: {
    regular: { fontFamily: face.regular, fontWeight: "400" },
    medium: { fontFamily: face.medium, fontWeight: "500" },
    bold: { fontFamily: face.semibold, fontWeight: "600" },
    heavy: { fontFamily: face.semibold, fontWeight: "700" },
  },
};

export const SHELL_SCREEN_OPTIONS: NativeStackNavigationOptions = {
  headerStyle: { backgroundColor: ground.raised },
  headerTintColor: ink.bright,
  headerTitleStyle: { fontFamily: face.semibold, fontSize: type.title.fontSize },
  // A drop shadow under a hairline-ruled design is a second border in a
  // different language.
  headerShadowVisible: false,
  contentStyle: { backgroundColor: ground.base },
};

/**
 * For the surfaces that draw their own top bar.
 *
 * An agent log and a terminal prompt both carry an identity bar coloured by
 * that session's live state, which a generic header cannot express, and two
 * stacked bars on a 390pt phone is most of the screen gone. The stack still
 * owns the push, the back gesture, and the Android back button on those routes;
 * only the bar is the screen's.
 */
export const OWN_CHROME: NativeStackNavigationOptions = { headerShown: false };
