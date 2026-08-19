/**
 * One place that owns the system insets.
 *
 * Notch, Dynamic Island, home indicator, and the Android status/nav bars are
 * not layout decoration: a header drawn under them is untappable, and a
 * composer drawn under the home indicator is unusable. Every full-screen
 * surface goes through this shell so a new screen cannot forget.
 *
 * The inset lives on an outer shell. The caller's style, including any design
 * padding, lives on an inner content view. That split is the whole point: the
 * two never fight over the same `padding*` keys, so a pairing form that wants
 * `space.loose` still gets it on a phone with a notch, and a web build with
 * zero insets still keeps its design padding.
 *
 * ## Why it asks the navigator about the top edge
 *
 * A stack header already sits inside the top inset: it is drawn below the
 * status bar and its own height includes that inset. A screen under one that
 * also pads by `insets.top` pushes its content down by the inset twice, which
 * on the operator's phone is 47pt of dead band under the header. So the top
 * edge is conditional on whether a header is actually above this screen, which
 * the navigator answers through `HeaderHeightContext`: undefined outside a
 * navigator, zero on a route whose header is hidden, and the drawn height when
 * there is one. Asking that question here rather than passing `edges` per route
 * is deliberate: a screen this shell has never heard of, including one another
 * author adds later, gets the right answer without knowing the rule exists.
 */

import { HeaderHeightContext } from "@react-navigation/elements";
import type { JSX, ReactNode } from "react";
import { useContext } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ground } from "./tokens.ts";

export function SafeScreen({
  children,
  style,
  testID,
  edges = { top: true, bottom: true, left: true, right: true },
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Which edges take the system inset. A screen that already has a sticky
   * bottom composer still wants the bottom inset on that composer, not on the
   * outer shell twice; pass `bottom: false` there and pad the composer itself.
   */
  edges?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
}): JSX.Element {
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext);
  const headerOwnsTop = headerHeight !== undefined && headerHeight > 0;
  return (
    <View
      testID={testID}
      style={[
        styles.shell,
        {
          paddingTop: edges.top === false || headerOwnsTop ? 0 : insets.top,
          paddingBottom: edges.bottom === false ? 0 : insets.bottom,
          paddingLeft: edges.left === false ? 0 : insets.left,
          paddingRight: edges.right === false ? 0 : insets.right,
        },
      ]}
    >
      <View style={[styles.content, style]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: ground.base },
  content: { flex: 1 },
});
