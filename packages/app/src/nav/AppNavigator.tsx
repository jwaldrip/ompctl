/**
 * The shell: one navigator, one header, one menu.
 *
 * Screens used to be swapped by hand from `Console`'s own state, which is why
 * the app had no header, no back affordance, no swipe-back, and nowhere to put
 * a control that is not part of a screen. A native stack fixes all four at
 * once: the push is native, the back gesture is the platform's, the header is
 * drawn inside the top inset, and the menu is a route rather than a widget
 * somebody has to find at the bottom of a scroll.
 *
 * ## Selection is the model; the stack presents it
 *
 * `Console`'s reducer owns which session is open, and it is not only gestures
 * that change it: claiming a dormant session opens whatever agent the daemon
 * answers with, and a lost agent closes itself. So navigation follows the
 * model, in exactly one effect below, rather than each caller remembering to
 * push. The reverse direction is one listener: when the last detail route
 * leaves the stack, by back button, swipe, or Android back, the model is told
 * the session is no longer open. Those two are the whole sync, and neither can
 * fight the other, because each only acts when the two disagree.
 *
 * ## Surfaces come from the console, routes come from here
 *
 * This module knows route names, options, the header, and the menu. It knows
 * nothing about sockets, agents, or the browser reducer: `Console` passes the
 * surfaces as functions, which is what keeps the navigator renderable in a
 * test from a canned state.
 */

import type { AgentId } from "@ompd/core/contracts";
import { NavigationContainer, StackActions, useNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackNavigationProp, NativeStackScreenProps } from "@react-navigation/native-stack";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { JSX } from "react";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import { OWN_CHROME, SHELL_SCREEN_OPTIONS, SHELL_THEME } from "./theme.ts";

export type ShellParamList = {
  fleet: undefined;
  session: { agentId: AgentId };
  menu: undefined;
  connections: undefined;
  invite: undefined;
  newSession: undefined;
  cowork: undefined;
  agentConfig: { agentId: AgentId };
  settings: undefined;
  routines: undefined;
};

/** Which detail surface the console model says is open. */
export type ShellSelection = { kind: "session"; agentId: AgentId };

/**
 * What the console hands the shell: the header's subject, one gate, and a
 * function per route. Functions rather than elements, so a route that is not
 * on screen costs nothing to register.
 */
export interface ShellSurfaces {
  /** The header's title on the list: which daemon this device is attached to. */
  daemonLabel: string;
  /**
   * Whether this pairing holds the scope an invite spends. A menu entry that
   * the daemon would refuse is worse than no entry, so it is absent instead.
   */
  canInvite: boolean;
  fleet: () => JSX.Element;
  /**
   * The two detail surfaces take the way back rather than closing themselves.
   * There is one way out of a pushed route and it is the stack: the screen's own
   * control, the swipe, and Android back then all pop, and the listener below
   * tells the model once. A screen that cleared the model directly instead would
   * leave the swipe and the hardware button on a different path from its own
   * button, which is how one of the three ends up not working.
   *
   * The log also takes the way into its agent's config, supplied here so the
   * session screen never needs to know a navigator exists.
   */
  session: (agentId: AgentId, back: () => void, openConfig: () => void) => JSX.Element;
  connections: (back: () => void, invite: () => void, settings: () => void) => JSX.Element;
  invite: (done: () => void) => JSX.Element;
  /**
   * Read and change the daemon's own settings: its policy posture and its
   * keep-awake. Rides the connection's socket, so it reaches a hub-paired
   * phone the same as a direct one.
   */
  settings: (back: () => void) => JSX.Element;
  /** Configure ordered routine actions and inspect their individual outcomes. */
  routines: (back: () => void) => JSX.Element;
  /**
   * Browse the daemon's machine and start a session, or clone a repo, where
   * the operator chooses. `done` is the way back, on the same one-way-out
   * rule the detail routes follow.
   */
  newSession: (done: () => void) => JSX.Element;
  /**
   * The daemon's tasks, skills, and connectors. Registered beside `newSession`
   * because it is the same class of act, starting work on the daemon rather
   * than reading a session already running, and it takes `done` for the same
   * one-way-out reason.
   */
  cowork: (done: () => void) => JSX.Element;
  /**
   * One agent's mode and model, pushed from its open session. The agent id
   * comes from the route, which got it from that session, so this surface can
   * never describe a session other than the one it was opened from.
   */
  agentConfig: (agentId: AgentId, back: () => void) => JSX.Element;
}

export interface AppNavigatorProps {
  surfaces: ShellSurfaces;
  /**
   * The open detail surface, or null for the list. Null on a split layout too:
   * there the detail sits beside the list rather than on top of it, and pushing
   * a route would hide the list it is meant to sit next to.
   */
  selection: ShellSelection | null;
  /** Called when the last detail route has left the stack. */
  onLeaveSelection: () => void;
}

const Stack = createNativeStackNavigator<ShellParamList>();

const SurfaceContext = createContext<ShellSurfaces | null>(null);

function useSurfaces(): ShellSurfaces {
  const surfaces = useContext(SurfaceContext);
  if (surfaces === null) throw new Error("a shell route rendered outside AppNavigator");
  return surfaces;
}

/** The two routes that present an open session, as opposed to the shell around it. */
const DETAIL_ROUTES: Record<string, true> = { session: true };

export function AppNavigator({ surfaces, selection, onLeaveSelection }: AppNavigatorProps): JSX.Element {
  const navigation = useNavigationContainerRef<ShellParamList>();

  // Read rather than depended on: `onLeaveSelection` is rebuilt by `Console`
  // on every socket frame, and a listener that resubscribed on each of those
  // would be re-registering during a live turn for no gain.
  const leave = useRef(onLeaveSelection);
  leave.current = onLeaveSelection;
  const openSelection = useRef(selection);
  openSelection.current = selection;

  useEffect(() => {
    if (!navigation.isReady()) return;
    const routes = navigation.getRootState().routes;
    const focused = routes[routes.length - 1];
    const stackHasDetail = routes.some(route => DETAIL_ROUTES[route.name] === true);

    if (selection === null) {
      if (stackHasDetail) navigation.dispatch(StackActions.popToTop());
      return;
    }

    if (selection.kind === "session") {
      const params = focused?.params as ShellParamList["session"] | undefined;
      if (focused?.name === "session" && params?.agentId === selection.agentId) return;
      // Two detail surfaces never stack: the model holds one open session at a
      // time, so a switch replaces rather than buries the previous one.
      if (stackHasDetail) navigation.dispatch(StackActions.popToTop());
      navigation.navigate("session", { agentId: selection.agentId });
    }
  }, [selection, navigation]);

  const onStateChange = useCallback(() => {
    if (openSelection.current === null || !navigation.isReady()) return;
    const stackHasDetail = navigation.getRootState().routes.some(route => DETAIL_ROUTES[route.name] === true);
    // A detail route still under an open menu is not a closed session, which is
    // why this asks the whole stack rather than the focused route.
    if (!stackHasDetail) leave.current();
  }, [navigation]);

  return (
    <SurfaceContext.Provider value={surfaces}>
      <NavigationContainer ref={navigation} theme={SHELL_THEME} onStateChange={onStateChange}>
        <Stack.Navigator initialRouteName="fleet" screenOptions={SHELL_SCREEN_OPTIONS}>
          <Stack.Screen
            name="fleet"
            component={FleetRoute}
            options={({ navigation: nav }) => ({
              // The daemon's name, because "Sessions" is already on the list
              // below and which machine this is was previously only findable by
              // scrolling to the bottom of the screen.
              title: surfaces.daemonLabel,
              headerRight: () => (
                <Pressable
                  testID="open-menu"
                  accessibilityRole="button"
                  accessibilityLabel="Menu"
                  onPress={() => nav.navigate("menu")}
                  style={menuButtonStyle}
                >
                  <Glyph name="menu" size={16} color={ink.bright} />
                </Pressable>
              ),
            })}
          />
          <Stack.Screen name="session" component={SessionRoute} options={OWN_CHROME} />
          <Stack.Screen name="cowork" component={CoworkRoute} options={COWORK_OPTIONS} />
          <Stack.Screen name="agentConfig" component={AgentConfigRoute} options={OWN_CHROME} />
          <Stack.Screen name="menu" component={MenuRoute} options={{ title: "Menu", presentation: "modal" }} />
          <Stack.Screen name="connections" component={ConnectionsRoute} options={CONNECTIONS_OPTIONS} />
          <Stack.Screen name="invite" component={InviteRoute} options={INVITE_OPTIONS} />
          <Stack.Screen name="newSession" component={NewSessionRoute} options={NEW_SESSION_OPTIONS} />
          <Stack.Screen name="settings" component={SettingsRoute} options={SETTINGS_OPTIONS} />
          <Stack.Screen name="routines" component={RoutinesRoute} options={ROUTINES_OPTIONS} />
        </Stack.Navigator>
      </NavigationContainer>
    </SurfaceContext.Provider>
  );
}

// Both screens draw their own heading, so the stack contributes the back
// affordance and the title, not a second heading.
const CONNECTIONS_OPTIONS = { title: "Connections" } as const;
const INVITE_OPTIONS = { title: "Invite a device" } as const;
const NEW_SESSION_OPTIONS = { title: "New session" } as const;
const COWORK_OPTIONS = { title: "Cowork" } as const;
const SETTINGS_OPTIONS = { title: "Daemon settings" } as const;
const ROUTINES_OPTIONS = { title: "Routines" } as const;

function FleetRoute(): JSX.Element {
  return useSurfaces().fleet();
}

function SessionRoute({ route, navigation }: NativeStackScreenProps<ShellParamList, "session">): JSX.Element {
  // The config entry rides the session it configures, carrying the same agent
  // id this route holds, so what it opens can never be another session.
  return useSurfaces().session(
    route.params.agentId,
    () => navigation.goBack(),
    () => navigation.navigate("agentConfig", { agentId: route.params.agentId }),
  );
}

function AgentConfigRoute({ route, navigation }: NativeStackScreenProps<ShellParamList, "agentConfig">): JSX.Element {
  return useSurfaces().agentConfig(route.params.agentId, () => navigation.goBack());
}

function ConnectionsRoute({ navigation }: NativeStackScreenProps<ShellParamList, "connections">): JSX.Element {
  return useSurfaces().connections(
    () => navigation.goBack(),
    () => navigation.navigate("invite"),
    () => navigation.navigate("settings"),
  );
}

function InviteRoute({ navigation }: NativeStackScreenProps<ShellParamList, "invite">): JSX.Element {
  return useSurfaces().invite(() => navigation.goBack());
}

function SettingsRoute({ navigation }: NativeStackScreenProps<ShellParamList, "settings">): JSX.Element {
  return useSurfaces().settings(() => navigation.goBack());
}

function RoutinesRoute({ navigation }: NativeStackScreenProps<ShellParamList, "routines">): JSX.Element {
  return useSurfaces().routines(() => navigation.goBack());
}

function NewSessionRoute({ navigation }: NativeStackScreenProps<ShellParamList, "newSession">): JSX.Element {
  return useSurfaces().newSession(() => navigation.goBack());
}

function CoworkRoute({ navigation }: NativeStackScreenProps<ShellParamList, "cowork">): JSX.Element {
  return useSurfaces().cowork(() => navigation.goBack());
}

type MenuNavigation = NativeStackNavigationProp<ShellParamList, "menu">;

interface MenuItem {
  readonly title: string;
  readonly detail: string;
  readonly glyph: GlyphName;
  readonly testID: string;
  /** Entries that spend this device's own approve scope are absent without it. */
  readonly requiresApprove?: true;
  /**
   * Dismiss, then go: the menu is a modal, so navigating from it without
   * dismissing would leave the destination stacked on top of a sheet.
   */
  readonly go: (navigation: MenuNavigation) => void;
}

/**
 * The menu, as data.
 *
 * Everything here was previously either unreachable or pinned to the bottom of
 * a scrolling list. Adding a destination is one entry: a sibling's remote
 * "New session" screen lands as `{ title: "New session", ..., go: nav => {
 * nav.goBack(); nav.navigate("newSession"); } }` alongside one more
 * `Stack.Screen` above.
 */
const MENU_ITEMS: readonly MenuItem[] = [
  {
    title: "Connections",
    detail: "Switch which daemon this device is attached to",
    glyph: "link",
    testID: "menu-connections",
    go: navigation => {
      navigation.goBack();
      navigation.navigate("connections");
    },
  },
  {
    title: "Invite a device",
    detail: "Mint a pairing credential for another phone or laptop",
    glyph: "qrcode",
    testID: "menu-invite",
    requiresApprove: true,
    go: navigation => {
      navigation.goBack();
      navigation.navigate("invite");
    },
  },
  {
    title: "New session",
    detail: "Browse this machine and start an agent, or clone a repo first",
    glyph: "bay",
    testID: "menu-new-session",
    go: navigation => {
      navigation.goBack();
      navigation.navigate("newSession");
    },
  },
  {
    title: "Cowork",
    // Named for what the surface holds rather than for the word "cowork",
    // which says nothing to an operator who has not read the code.
    detail: "Tasks, skills, and connectors on this daemon",
    // The same glyph the surface's own Tasks destination wears, because tasks
    // are what it opens on. `bay` is spent on New session above.
    glyph: "tasks",
    testID: "open-cowork",
    go: navigation => {
      navigation.goBack();
      navigation.navigate("cowork");
    },
  },
  {
    title: "Routines",
    detail: "Fan one trigger out to several ordered actions",
    glyph: "tasks",
    testID: "menu-routines",
    go: navigation => {
      navigation.goBack();
      navigation.navigate("routines");
    },
  },
];

function MenuRoute({ navigation }: NativeStackScreenProps<ShellParamList, "menu">): JSX.Element {
  const { canInvite } = useSurfaces();
  return (
    <SafeScreen testID="shell-menu">
      <ScrollView>
        {MENU_ITEMS.filter(item => item.requiresApprove !== true || canInvite).map(item => (
          <Pressable
            key={item.testID}
            testID={item.testID}
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={() => {
              item.go(navigation);
            }}
            style={menuRowStyle}
          >
            <Glyph name={item.glyph} size={16} color={ink.plain} />
            <View style={styles.menuText}>
              <Title>{item.title}</Title>
              <Label color={ink.muted}>{item.detail}</Label>
            </View>
            <Glyph name="chevron" size={12} color={ink.faint} />
          </Pressable>
        ))}
      </ScrollView>
      <Pressable
        testID="menu-close"
        accessibilityRole="button"
        accessibilityLabel="Close the menu"
        onPress={() => {
          navigation.goBack();
        }}
        style={menuCloseStyle}
      >
        <Kicker color={ink.plain}>Close</Kicker>
      </Pressable>
    </SafeScreen>
  );
}

const menuButtonStyle = ({ pressed }: { pressed: boolean }) => [styles.menuButton, pressed && styles.pressed];
const menuRowStyle = ({ pressed }: { pressed: boolean }) => [styles.menuRow, pressed && styles.pressed];
const menuCloseStyle = ({ pressed }: { pressed: boolean }) => [styles.menuClose, pressed && styles.pressed];

const styles = StyleSheet.create({
  menuButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    minHeight: TOUCH_TARGET,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  menuText: { flex: 1, gap: space.hair },
  menuClose: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
  pressed: { backgroundColor: ground.active },
});
