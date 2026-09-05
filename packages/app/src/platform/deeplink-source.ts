import { Linking } from "react-native";
import type { DeepLinkSource } from "./deeplink.ts";

export const nativeDeepLinks: DeepLinkSource = {
  getInitialURL: () => Linking.getInitialURL(),
  addEventListener: (event, listener) => Linking.addEventListener(event, listener),
};
