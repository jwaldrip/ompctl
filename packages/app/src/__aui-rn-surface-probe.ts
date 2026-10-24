// Throwaway probe. Not part of the app.
// The complete set of names @assistant-ui/react-native imports from
// "react-native", asserted to exist. react-native-web ships no .d.ts, so the
// TYPE half always resolves against react-native@0.81.6 even for the web build;
// the VALUE half is what react-native-web has to supply at bundle time.
import { FlatList, Platform, Pressable, Text, TextInput, View } from "react-native";
import type { FlatListProps, PressableProps, PressableStateCallbackType, TextInputProps, TextProps, ViewProps } from "react-native";

export const values = { FlatList, Platform, Pressable, Text, TextInput, View };

export type Types = {
  flatList: FlatListProps<unknown>;
  pressable: PressableProps;
  pressableState: PressableStateCallbackType;
  textInput: TextInputProps;
  text: TextProps;
  view: ViewProps;
};
