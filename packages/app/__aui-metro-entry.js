// Throwaway Metro-resolution probe entry. Not part of the app.
// Bundling this proves every @assistant-ui specifier resolves through the
// project's real metro.config.cjs (disableHierarchicalLookup: true).
import { AppRegistry } from "react-native";
import { AuiProbe } from "./src/__aui-probe.tsx";

AppRegistry.registerComponent("AuiProbe", () => AuiProbe);
