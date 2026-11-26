import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { addSchedule, parseDuration, removeSchedule, Schedules, takeDue, Timer, type Schedule } from "./schedule.ts";

type Open = { harness: Harness; release: () => Promise<void> };
const STATUS = "pi-schedule";
// A reload replaces this module but keeps the process, its lock, and the open harness; the next instance reuses them.
const OPEN_KEY = Symbol.for("pi-schedule.open");
const opened = () => ((globalThis as Record<symbol, Map<string, Promise<Open>> | undefined>)[OPEN_KEY] ??= new Map());

async function lock(path: string) {
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const contents = await readFile(path, "utf8").catch(() => "");
    if (!/^[1-9]\d*$/.test(contents)) throw new Error(`Schedule lock ${path} has no process ID; remove it after confirming no Pi uses this session`);
    const pid = Number(contents);
    try { process.kill(pid, 0); } catch (check: any) { if (check.code === "ESRCH") throw new Error(`Stale schedule lock for pid ${pid}; remove ${path} after confirming that process is gone`); }
    throw new Error(`Schedules for this session are open in pid ${pid}`);
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return async () => { if (Number(await readFile(path, "utf8").catch(() => "")) === process.pid) await unlink(path).catch(() => {}); };
}

const when = (at: number) => new Date(at).toLocaleString();
const describe = (item: Schedule) => `${item.id} · ${item.every ? `every ${item.every / 60_000}m` : "once"} · next ${when(item.nextAt)} · fired ${item.fires}${item.due ? " · due" : ""}\n  ${item.prompt}`;

/**
 * Durable reminders and repeating prompts for one Pi session. Timers are pi-durable tasks asleep in a SQLite store next
 * to the session, so they survive restarts; a time that passed while Pi was closed fires once when it opens again. A
 * due prompt is sent as a user message as soon as Pi is idle.
 */
export default function (pi: ExtensionAPI) {
  let open: Promise<Open> | undefined;
  let openKey: string | undefined;
  let stopWatch: (() => Promise<unknown>) | undefined;
  let ctxRef: ExtensionContext | undefined;
  let delivering = false;

  function storeKey(ctx: ExtensionContext) {
    const dir = ctx.sessionManager.getSessionDir();
    const key = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex").slice(0, 24);
    return dir ? join(dir, `pi-schedule-${key}.sqlite`) : `memory:${key}`;
  }

  async function openStore(ctx: ExtensionContext): Promise<Open> {
    const dir = ctx.sessionManager.getSessionDir();
    let release = async () => {};
    let storage;
    if (dir) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = storeKey(ctx);
      release = await lock(`${path}.lock`);
      try { storage = await openNodeSqliteStorage(path, { busyTimeoutMs: 5000 }); await chmod(path, 0o600); }
      catch (error) { await release(); throw error; }
    } else storage = new MemoryStorage();
    const registry = createRegistry();
    registry.install(defineExtension({ name: "schedule", tasks: [Timer] }));
    const harness = await Harness.open(storage, { models: createModels(), registry }, C);
    harness.resume();
    await harness.commit(async (tx) => { await tx.doc(Schedules); }, C);
    return { harness, release };
  }

  async function openFor(ctx: ExtensionContext): Promise<Open> {
    const key = storeKey(ctx), store = opened();
    let shared: Promise<Open> | undefined = store.get(key);
    if (!shared) {
      shared = openStore(ctx);
      store.set(key, shared);
      shared.catch(() => { if (store.get(key) === shared) store.delete(key); });
    }
    const current: Open = await shared;
    openKey = key;
    const watch = (await current.harness.watchDoc(Schedules, C))!;
    watch.start(async (call) => { if (call.kind === "value") { status(call.value.schedules); void deliver(); } });
    status(watch.value.schedules);
    stopWatch = () => watch.stop();
    return current;
  }

  function status(schedules: readonly Schedule[]) {
    const next = schedules.reduce<number | undefined>((min, item) => min === undefined || item.nextAt < min ? item.nextAt : min, undefined);
    ctxRef?.ui.setStatus(STATUS, schedules.length ? `schedule ${schedules.length} · next ${next ? when(next) : "-"}` : undefined);
  }

  async function deliver() {
    if (delivering || !open || !ctxRef?.isIdle()) return;
    delivering = true;
    try {
      const due = await takeDue((await open).harness);
      if (due) pi.sendUserMessage(`[scheduled ${due.id}] ${due.prompt}`);
    } finally { delivering = false; }
  }

  const ensure = (ctx: ExtensionContext) => (open ??= openFor(ctx).catch((error) => { open = undefined; throw error; }));

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    void ensure(ctx).then(deliver).catch((error) => ctx.ui.setStatus(STATUS, error instanceof Error ? error.message : String(error)));
  });
  pi.on("agent_settled", () => { void deliver(); });
  pi.on("session_shutdown", async (event: any) => {
    if (!open) return;
    const current = await open.catch(() => undefined);
    open = undefined;
    await stopWatch?.();
    stopWatch = undefined;
    if (!current || event.reason === "reload") return;
    opened().delete(openKey!);
    await current.harness.close(C);
    await current.release();
  });

  pi.registerCommand("schedule", {
    description: "Durable reminders: in <30m|2h|1d> <prompt>, every <dur> <prompt>, list, cancel <id>",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const { harness } = await ensure(ctx);
      const [verb = "list", amount = "", ...rest] = args.trim().split(/\s+/);
      const prompt = rest.join(" ").trim();
      if (verb === "list") {
        const schedules = (await harness.snapshot(Schedules, C))?.schedules ?? [];
        return ctx.ui.notify(schedules.length ? schedules.map(describe).join("\n") : "No schedules.", "info");
      }
      if (verb === "cancel") {
        const removed = await removeSchedule(harness, amount);
        return ctx.ui.notify(removed ? `Cancelled ${removed.id}.` : `No schedule ${amount}.`, removed ? "info" : "warning");
      }
      const ms = parseDuration(amount);
      if ((verb !== "in" && verb !== "every") || !ms || !prompt) return ctx.ui.notify("Usage: /schedule in|every <1m..366d, e.g. 30m, 2h, 1d> <prompt> · /schedule list · /schedule cancel <id>", "warning");
      const id = await addSchedule(harness, prompt, Date.now() + ms, verb === "every" ? ms : undefined);
      ctx.ui.notify(`Scheduled ${id} ${verb} ${amount}; first at ${when(Date.now() + ms)}.`, "info");
    },
  });
}
