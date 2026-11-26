import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { addSchedule, parseDuration, removeSchedule, Schedules, takeDue, Timer } from "./schedule.ts";

test("durations accept one minute to a year and reject the rest", () => {
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  for (const bad of ["30s", "400d", "5", "m", "-1h"]) assert.equal(parseDuration(bad), undefined, bad);
});

test("timers survive a restart, a missed slot fires once, and a cancelled timer never fires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "schedule-"));
  let now = 1_000_000;
  const open = async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "schedule", tasks: [Timer] }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models: createModels(), registry, now: () => now }, C);
    harness.resume();
    return harness;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    let harness = await open();
    const once = await addSchedule(harness, "standup", now + 60_000);
    const hourly = await addSchedule(harness, "check CI", now + 3_600_000, 3_600_000);
    const cancelled = await addSchedule(harness, "never", now + 60_000);
    await removeSchedule(harness, cancelled);
    await settle();
    assert.equal(await takeDue(harness), undefined);
    await harness.close(C);

    now += 3 * 3_600_000 + 5;
    harness = await open();
    await settle();
    const first = await takeDue(harness);
    const second = await takeDue(harness);
    assert.deepEqual([first?.id, second?.id], [once, hourly]);
    assert.equal(await takeDue(harness), undefined);
    const left = (await harness.snapshot(Schedules, C))!.schedules;
    assert.deepEqual(left.map((item) => item.id), [hourly]);
    assert.equal(left[0].nextAt, 1_000_000 + 4 * 3_600_000);
    await harness.close(C);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
