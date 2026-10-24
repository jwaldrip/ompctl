// Throwaway vite config for the @assistant-ui web-resolution probe.
// Reuses the real config wholesale and only swaps the html entry, so the
// react-native -> react-native-web alias under test is the app's own.
import { mergeConfig } from "vite";
import base from "./vite.config.ts";

export default mergeConfig(base, {
  build: {
    outDir: "/tmp/aui-web-probe",
    emptyOutDir: true,
    rollupOptions: { input: "./__aui-web-probe.html" },
  },
});
