import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSessionFiles } from "../../src/sessions/watcher.ts";

class SilentWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

async function expectReconciledAfterMissedEvent(
  mutate: (root: string) => void,
  setup: (root: string) => void = () => {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "session-watch-reconcile-"));
  setup(root);
  const watchers: SilentWatcher[] = [];
  const changed = Promise.withResolvers<void>();
  const handle = watchSessionFiles(root, changed.resolve, {
    quietMs: 5,
    maxWaitMs: 20,
    reconcileMs: 10,
    watchFactory: () => {
      const watcher = new SilentWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
  });
  expect(handle).not.toBeNull();
  try {
    mutate(root);
    const timeout = Bun.sleep(250).then(() => {
      throw new Error("missed filesystem event was not reconciled");
    });
    await Promise.race([changed.promise, timeout]);
  } finally {
    handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
  expect(watchers.every(watcher => watcher.closed)).toBe(true);
}

test("directory reconciliation discovers a session group when every watch event is missed", async () => {
  await expectReconciledAfterMissedEvent(root => {
    const group = join(root, "-new");
    mkdirSync(group);
    writeFileSync(join(group, "2026-09-10T00-00-00-000Z_019feed0-0000-7000-8000-000000000000.jsonl"), "{}\n");
  });
});

test("directory reconciliation detects a deleted session when every watch event is missed", async () => {
  const file = (root: string) =>
    join(root, "-existing", "2026-09-10T00-00-00-000Z_019feed0-0000-7000-8000-000000000001.jsonl");
  await expectReconciledAfterMissedEvent(
    root => rmSync(file(root)),
    root => {
      mkdirSync(join(root, "-existing"));
      writeFileSync(file(root), "{}\n");
    },
  );
});
