/**
 * Before there is a daemon to talk to: pair, or scan a code that pairs.
 *
 * The same stack as the shell, with the same theme, because a device being
 * paired is not a different application. Scanning used to be a boolean inside
 * `PairScreen`, which meant the camera surface had no back gesture and no
 * place in the navigation state; it is a route here, and the form's scan entry
 * pushes it like any other screen.
 *
 * Both screens draw their own layout and their own cancel control, so the stack
 * contributes the push and the gesture rather than a header: a title bar over a
 * full-bleed camera is chrome nobody asked for.
 */

import { NavigationContainer } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { JSX } from "react";
import { createContext, useContext } from "react";
import type { Connection } from "../platform/connection.ts";
import { PairScreen } from "../screens/PairScreen.tsx";
// Deliberately extensionless, like `PairScreen`'s own import used to be: that
// is what lets `ScanScreen.web.tsx` win in the browser via `resolve.extensions`,
// where vision-camera cannot be bundled at all.
import { ScanScreen } from "../screens/ScanScreen";
import { OWN_CHROME, SHELL_SCREEN_OPTIONS, SHELL_THEME } from "./theme.ts";

type PairParamList = {
  pair: undefined;
  scan: undefined;
};

export interface PairNavigatorProps {
  /** Why the operator is looking at this screen rather than at their sessions. */
  notice?: string;
  /** Default target address to prefill. */
  defaultTarget?: string;
  /** Present only when there is a saved daemon to go back to. */
  onCancel?: () => void;
  onPair: (connection: Connection) => void;
}

const Stack = createNativeStackNavigator<PairParamList>();

const PairContext = createContext<PairNavigatorProps | null>(null);

function usePairing(): PairNavigatorProps {
  const pairing = useContext(PairContext);
  if (pairing === null) throw new Error("a pairing route rendered outside PairNavigator");
  return pairing;
}

export function PairNavigator(props: PairNavigatorProps): JSX.Element {
  return (
    <PairContext.Provider value={props}>
      <NavigationContainer theme={SHELL_THEME}>
        <Stack.Navigator initialRouteName="pair" screenOptions={SHELL_SCREEN_OPTIONS}>
          <Stack.Screen name="pair" component={PairRoute} options={OWN_CHROME} />
          <Stack.Screen name="scan" component={ScanRoute} options={OWN_CHROME} />
        </Stack.Navigator>
      </NavigationContainer>
    </PairContext.Provider>
  );
}

function PairRoute({ navigation }: NativeStackScreenProps<PairParamList, "pair">): JSX.Element {
  const pairing = usePairing();
  return (
    <PairScreen
      notice={pairing.notice}
      defaultTarget={pairing.defaultTarget}
      onCancel={pairing.onCancel}
      onPair={pairing.onPair}
      onScan={() => navigation.navigate("scan")}
    />
  );
}

function ScanRoute({ navigation }: NativeStackScreenProps<PairParamList, "scan">): JSX.Element {
  const pairing = usePairing();
  return (
    <ScanScreen
      onCancel={() => navigation.goBack()}
      // A scanned bundle carries an endpoint and a token together, so it saves
      // through the same `onPair` the typed form uses: a scan and a paste are
      // indistinguishable to everything downstream. The screen pops first, so
      // the camera is released before the console mounts.
      onScanned={connection => {
        navigation.goBack();
        pairing.onPair(connection);
      }}
    />
  );
}
