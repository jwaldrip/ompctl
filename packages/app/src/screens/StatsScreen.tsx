/**
 * System-wide statistics and usage dashboard.
 *
 * Renders aggregate token consumption, spend, cache performance,
 * latency, model distributions, and daily burn across all sessions.
 */

import type { DashboardStats } from "@ompd/core/contracts";
import type { ClientErrorEvent, OmpdClient, StatsEvent, StatusEvent } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { createOmpdClient } from "../console/useConsole.ts";
import { formatTokens } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Data, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, radius, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

export interface StatsClient {
  stats(range?: string): void;
  on(event: "stats", listener: (event: StatsEvent) => void): () => void;
  on(event: "error", listener: (event: ClientErrorEvent) => void): () => void;
  on(event: "status", listener: (event: StatusEvent) => void): () => void;
  start?(): void;
  close?(): void;
}

export interface StatsScreenProps {
  connection?: Connection;
  stats?: DashboardStats;
  client?: StatsClient;
  createClient?: (connection: Connection) => OmpdClient;
  onBack: () => void;
}

const RANGES = ["24h", "7d", "30d", "all"] as const;
type Range = (typeof RANGES)[number];


function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "--";
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `$${n.toFixed(digits)}`;
  }
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "not reported";
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "not reported";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StatsScreen({
  connection,
  stats: initialStats,
  client: externalClient,
  createClient = createOmpdClient,
  onBack,
}: StatsScreenProps): JSX.Element {
  const [range, setRange] = useState<Range>("7d");
  const [loadedStats, setLoadedStats] = useState<DashboardStats | null>(initialStats ?? null);
  const [loading, setLoading] = useState<boolean>(
    initialStats === undefined && (externalClient !== undefined || connection !== undefined),
  );
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<StatsClient | null>(null);
  if (externalClient) {
    clientRef.current = externalClient;
  } else if (clientRef.current === null && connection) {
    clientRef.current = createClient(connection);
  }
  const client = clientRef.current;

  useEffect(() => {
    if (initialStats) {
      setLoadedStats(initialStats);
      setLoading(false);
      return;
    }
    if (!client) return;

    setLoading(true);
    setError(null);

    const offs = [
      client.on("stats", event => {
        setLoadedStats(event.stats);
        setLoading(false);
        setError(null);
      }),
      client.on("error", event => {
        setError(event.message);
        setLoading(false);
      }),
      client.on("status", event => {
        if (event.state === "connected") {
          client.stats(range);
        }
      }),
    ];
    client.start?.();
    client.stats(range);

    return () => {
      for (const off of offs) {
        if (off) off();
      }
      if (!externalClient) {
        client.close?.();
      }
    };
  }, [client, externalClient, initialStats]);

  const onSelectRange = useCallback(
    (newRange: Range) => {
      setRange(newRange);
      if (client) {
        setLoading(true);
        setError(null);
        client.stats(newRange);
      }
    },
    [client],
  );

  const activeStats = initialStats ?? loadedStats;

  const costByDay = useMemo(() => {
    if (!activeStats?.costSeries) return [];
    const byDay = new Map<string, number>();
    for (const pt of activeStats.costSeries) {
      const day = new Date(pt.timestamp).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + pt.cost);
    }
    return Array.from(byDay.entries())
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [activeStats]);

  const totalTokens = activeStats ? activeStats.overall.totalInputTokens + activeStats.overall.totalOutputTokens : 0;

  return (
    <SafeScreen style={styles.screen} testID="stats-screen">
      <View style={styles.appBar}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={onBack}
          style={styles.backButton}
          testID="stats-back"
        >
          <Glyph color={ink.plain} name="back" size={16} />
        </Pressable>
        <View style={styles.titleContainer}>
          <Title>Stats</Title>
        </View>
        <View style={styles.rangePills}>
          {RANGES.map(r => (
            <Pressable
              accessibilityLabel={`Filter by ${r}`}
              accessibilityRole="button"
              key={r}
              onPress={() => {
                onSelectRange(r);
              }}
              style={[styles.rangePill, range === r && styles.rangePillActive]}
              testID={`stats-range-${r}`}
            >
              <Label color={range === r ? ink.bright : ink.muted}>{r}</Label>
            </Pressable>
          ))}
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={ink.plain} />
        </View>
      ) : error ? (
        <View style={styles.notice} testID="stats-error">
          <Label color={signal.failed}>{error}</Label>
        </View>
      ) : activeStats ? (
        <ScrollView contentContainerStyle={styles.scrollContent} style={styles.scroll}>
          {/* Overview grid */}
          <View style={styles.section} testID="stats-overview">
            <Kicker color={ink.muted}>Overview</Kicker>
            <View style={styles.grid}>
              <View style={styles.card} testID="stats-overview-tokens">
                <View style={styles.cardHead}>
                  <Glyph color={ink.faint} name="load" size={11} />
                  <Label color={ink.muted}>Tokens</Label>
                </View>
                <Data color={ink.bright}>{formatTokens(totalTokens)}</Data>
                <Label color={ink.faint}>
                  in: {formatTokens(activeStats.overall.totalInputTokens)} / out:{" "}
                  {formatTokens(activeStats.overall.totalOutputTokens)}
                </Label>
              </View>

              <View style={styles.card} testID="stats-overview-cost">
                <View style={styles.cardHead}>
                  <Glyph color={ink.faint} name="cost" size={11} />
                  <Label color={ink.muted}>Spend</Label>
                </View>
                <Data color={ink.bright}>{formatCost(activeStats.overall.totalCost)}</Data>
                <Label color={ink.faint}>{activeStats.overall.totalRequests} requests</Label>
              </View>

              <View style={styles.card} testID="stats-overview-cache">
                <View style={styles.cardHead}>
                  <Label color={ink.muted}>Cache Rate</Label>
                </View>
                <Data color={signal.ready}>{formatPercent(activeStats.overall.cacheRate)}</Data>
                <Label color={ink.faint}>{formatTokens(activeStats.overall.totalCacheReadTokens)} read</Label>
              </View>

              <View style={styles.card} testID="stats-overview-errors">
                <View style={styles.cardHead}>
                  <Label color={ink.muted}>Error Rate</Label>
                </View>
                <Data color={activeStats.overall.errorRate > 0 ? signal.failed : ink.bright}>
                  {formatPercent(activeStats.overall.errorRate)}
                </Data>
                <Label color={ink.faint}>{activeStats.overall.failedRequests} failed</Label>
              </View>

              <View style={styles.card} testID="stats-overview-latency">
                <View style={styles.cardHead}>
                  <Label color={ink.muted}>Avg Latency</Label>
                </View>
                <Data color={ink.bright}>{formatDuration(activeStats.overall.avgDuration)}</Data>
                <Label color={ink.faint}>response duration</Label>
              </View>

              <View style={styles.card} testID="stats-overview-ttft">
                <View style={styles.cardHead}>
                  <Label color={ink.muted}>TTFT</Label>
                </View>
                <Data color={ink.bright}>{formatDuration(activeStats.overall.avgTtft)}</Data>
                <Label color={ink.faint}>time to first token</Label>
              </View>
            </View>
          </View>

          {/* Models table */}
          <View style={styles.section} testID="stats-models">
            <Kicker color={ink.muted}>Models</Kicker>
            {activeStats.byModel.length === 0 ? (
              <Body color={ink.muted}>No model stats reported for this range.</Body>
            ) : (
              <View style={styles.table}>
                <View style={styles.tableHeader}>
                  <Label color={ink.muted} style={styles.colModel}>
                    Model
                  </Label>
                  <Label color={ink.muted} style={styles.colNumber}>
                    Reqs
                  </Label>
                  <Label color={ink.muted} style={styles.colNumber}>
                    Tokens
                  </Label>
                  <Label color={ink.muted} style={styles.colNumber}>
                    Cost
                  </Label>
                </View>
                {activeStats.byModel.map(model => (
                  <View key={`${model.provider}/${model.model}`} style={styles.tableRow} testID={`stats-model-row`}>
                    <View style={styles.colModel}>
                      <Body color={ink.bright}>{model.model}</Body>
                      <Label color={ink.faint}>{model.provider}</Label>
                    </View>
                    <Data color={ink.plain} style={styles.colNumber}>
                      {model.totalRequests}
                    </Data>
                    <Data color={ink.plain} style={styles.colNumber}>
                      {formatTokens(model.totalInputTokens + model.totalOutputTokens)}
                    </Data>
                    <Data color={ink.bright} style={styles.colNumber}>
                      {formatCost(model.totalCost)}
                    </Data>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Cost by day */}
          <View style={styles.section} testID="stats-cost-by-day">
            <Kicker color={ink.muted}>Cost by Day</Kicker>
            {costByDay.length === 0 ? (
              <Body color={ink.muted}>No cost data available for this range.</Body>
            ) : (
              <View style={styles.dayList}>
                {costByDay.map(day => (
                  <View key={day.date} style={styles.dayRow} testID={`stats-day-row`}>
                    <Body color={ink.plain}>{day.date}</Body>
                    <Data color={ink.bright}>{formatCost(day.cost)}</Data>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      ) : null}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ground.base,
  },
  appBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.edge,
    minHeight: TOUCH_TARGET,
  },
  backButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  titleContainer: {
    flex: 1,
    paddingHorizontal: space.step,
  },
  rangePills: {
    flexDirection: "row",
    backgroundColor: ground.raised,
    borderRadius: radius.pill,
    padding: stroke.hair,
    gap: space.hair,
  },
  rangePill: {
    paddingHorizontal: space.step,
    paddingVertical: space.hair,
    borderRadius: radius.pill,
  },
  rangePillActive: {
    backgroundColor: ground.edge,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    margin: space.wide,
    padding: space.step,
    borderRadius: radius.surface,
    backgroundColor: ground.raised,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: space.wide,
    gap: space.wide,
  },
  section: {
    gap: space.step,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.step,
  },
  card: {
    flex: 1,
    minWidth: 140,
    backgroundColor: ground.surface,
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    borderRadius: radius.surface,
    padding: space.step,
    gap: space.hair,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.hair,
  },
  table: {
    backgroundColor: ground.surface,
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    borderRadius: radius.surface,
    overflow: "hidden",
  },
  tableHeader: {
    flexDirection: "row",
    paddingHorizontal: space.step,
    paddingVertical: space.hair,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.edge,
    backgroundColor: ground.raised,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.step,
    paddingVertical: space.step,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  colModel: {
    flex: 2,
  },
  colNumber: {
    flex: 1,
    textAlign: "right",
  },
  dayList: {
    backgroundColor: ground.surface,
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    borderRadius: radius.surface,
  },
  dayRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: space.step,
    paddingVertical: space.step,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
});
