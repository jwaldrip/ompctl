// Throwaway web-resolution probe. Not part of the app.
// Vite aliases `react-native` -> `react-native-web`, so bundling this proves
// @assistant-ui's react-native import surface survives the substitution.
import { createRoot } from "react-dom/client";
import { AuiProbe } from "./__aui-probe.tsx";

const el = document.getElementById("root");
if (el) createRoot(el).render(<AuiProbe messages={[]} />);
