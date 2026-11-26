import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type Harness, type TaskId } from "@earendil-works/pi-durable";

export type Schedule = { id: string; taskId: number; prompt: string; every?: number; nextAt: number; fires: number; due: boolean };
export type ScheduleState = { schedules: Schedule[] } & Record<string, JsonValue>;
export const Schedules = defineDoc<ScheduleState>({ kind: "schedule.state", version: 1, scope: "session", initial: () => ({ schedules: [] }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase > 32 });

export const MIN_INTERVAL_MS = 60_000;
export const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30m`, `2h`, `1d`: milliseconds, or undefined outside one minute to a year. */
export function parseDuration(text: string): number | undefined {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)([smhd])$/i);
  const ms = match ? Number(match[1]) * UNITS[match[2].toLowerCase()] : NaN;
  return Number.isFinite(ms) && ms >= MIN_INTERVAL_MS && ms <= MAX_DELAY_MS ? ms : undefined;
}

/**
 * One schedule's timer: sleeps until `nextAt`, then marks the schedule due. The sleep is stored, so it survives a
 * restart; a time that passed while Pi was closed fires once at the next open. A repeating schedule moves `nextAt`
 * to the next slot after now, so missed slots do not pile up.
 */
export const Timer = defineTask<{ id: string }, { phase: "sleep" } | { phase: "fire" }, null>({
  name: "schedule.timer",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (task, runtime, context) => {
      const schedule = (await runtime.snapshot(Schedules, context))?.schedules.find((item) => item.id === task.input.id);
      if (!schedule) return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      await runtime.sleepUntil(schedule.nextAt, { phase: "fire" }, context);
    },
    fire: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(Schedules);
        const schedule = state.schedules.find((item) => item.id === task.input.id);
        if (!schedule) return { status: "terminal", outcome: { status: "completed", result: null } };
        schedule.due = true;
        if (!schedule.every) return { status: "terminal", outcome: { status: "completed", result: null } };
        const now = runtime.now();
        schedule.nextAt += Math.ceil((now - schedule.nextAt + 1) / schedule.every) * schedule.every;
        return { status: "sleeping", until: schedule.nextAt, checkpoint: { phase: "fire" } };
      }, context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export async function addSchedule(harness: Harness, prompt: string, firstAt: number, every?: number) {
  const id = crypto.randomUUID().slice(0, 8);
  // Tasks live in a conversation; the root one holds every timer.
  const root = await harness.root(C);
  await harness.commit(async (tx) => {
    const taskId = await tx.createTask(Timer, { id }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
    (await tx.doc(Schedules)).schedules.push({ id, taskId, prompt, ...(every ? { every } : {}), nextAt: firstAt, fires: 0, due: false });
  }, C);
  return id;
}

export async function removeSchedule(harness: Harness, id: string) {
  const removed = await harness.commit(async (tx) => {
    const state = await tx.doc(Schedules);
    const schedule = state.schedules.find((item) => item.id === id);
    state.schedules = state.schedules.filter((item) => item.id !== id);
    // Draft values do not outlive the commit.
    return schedule && { ...schedule };
  }, C);
  if (removed) await harness.abortTask(removed.taskId as TaskId, C);
  return removed;
}

/** Takes the oldest due schedule and counts the fire; one-shot schedules leave the list. */
export async function takeDue(harness: Harness): Promise<Schedule | undefined> {
  return harness.commit(async (tx) => {
    const state = await tx.doc(Schedules);
    const schedule = state.schedules.filter((item) => item.due).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!schedule) return undefined;
    schedule.due = false;
    schedule.fires += 1;
    const taken = { ...schedule };
    if (!schedule.every) state.schedules = state.schedules.filter((item) => item.id !== schedule.id);
    return taken;
  }, C);
}
