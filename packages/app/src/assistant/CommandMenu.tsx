/**
 * The slash command menu, shown when a prompt begins with "/".
 *
 * Sits above the composer surface inside the same column so it pays no
 * separate window margin. Renders matching command names, descriptions,
 * and input hints, navigatable by arrow keys or tap.
 */

import { type JSX, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, radius, signal, space, stroke, type } from "../design/tokens.ts";
import type { SlashCommand } from "../session/model.ts";

export interface CommandMenuProps {
  prefix?: string;
  query: string;
  commands: readonly SlashCommand[] | readonly string[];
  commandDetails?: ReadonlyMap<string, SlashCommand>;
  selectedIndex?: number;
  onSelect: (command: SlashCommand) => void;
  onClose?: () => void;
  testID?: string;
}

export function cleanCommandName(name: string): string {
  return name.replace(/^\//, "");
}

export function CommandMenu({
  query,
  commands,
  commandDetails,
  selectedIndex = 0,
  onSelect,
  testID = "command-menu",
}: CommandMenuProps): JSX.Element | null {
  const filter = query.startsWith("/") ? query.slice(1).toLowerCase() : query.toLowerCase();

  const items = useMemo<SlashCommand[]>(() => {
    const list: SlashCommand[] = [];
    for (const item of commands) {
      if (typeof item === "string") {
        const details = commandDetails?.get(item);
        list.push(
          details ?? {
            name: item,
            description: "",
            hint: "",
          },
        );
      } else {
        list.push(item);
      }
    }
    return list.filter(cmd => {
      const clean = cmd.name.startsWith("/") ? cmd.name.slice(1) : cmd.name;
      return clean.toLowerCase().startsWith(filter);
    });
  }, [commands, commandDetails, filter]);

  if (items.length === 0) return null;

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.header}>
        <Glyph name="commands" size={12} color={signal.working} />
        <Label style={[type.kicker, styles.headerText]}>Commands</Label>
      </View>
      <ScrollView style={styles.list} keyboardShouldPersistTaps="always">
        {items.map((cmd, index) => {
          const clean = cmd.name.startsWith("/") ? cmd.name.slice(1) : cmd.name;
          const isSelected = index === selectedIndex;
          return (
            <Pressable
              key={cmd.name}
              testID={`command-item-${clean}`}
              accessibilityRole="button"
              accessibilityLabel={`Insert command /${clean}`}
              onPress={() => onSelect(cmd)}
              style={({ pressed }) => [styles.item, isSelected && styles.itemSelected, pressed && styles.itemPressed]}
            >
              <View style={styles.row}>
                <Label style={[type.code, styles.commandName]} testID="command-name">
                  /{clean}
                </Label>
                {cmd.hint ? (
                  <Label style={[type.label, styles.commandHint]} testID="command-hint">
                    {cmd.hint}
                  </Label>
                ) : null}
              </View>
              {cmd.description ? (
                <Label style={[type.label, styles.commandDescription]} numberOfLines={1} testID="command-description">
                  {cmd.description}
                </Label>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ground.surface,
    borderRadius: radius.control,
    borderWidth: stroke.hair,
    borderColor: ground.edge,
    maxHeight: 220,
    marginBottom: space.snug,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.edge,
    backgroundColor: ground.raised,
  },
  headerText: {
    color: ink.muted,
  },
  list: {
    maxHeight: 180,
  },
  item: {
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  itemSelected: {
    backgroundColor: ground.raised,
  },
  itemPressed: {
    backgroundColor: ground.active,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
  },
  commandName: {
    color: signal.working,
  },
  commandHint: {
    color: ink.faint,
  },
  commandDescription: {
    color: ink.muted,
    marginTop: 2,
  },
});
