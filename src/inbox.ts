// Notifications from outside the daemon (`acmd notify`, timers, scripts). Each one is a file in
// state/inbox; the daemon delivers and deletes it, including ones written while it was down.
import * as fs from "node:fs";
import * as path from "node:path";
import { monotonicFactory } from "ulid";
import { log } from "./log.js";
import { atomicWrite } from "./state.js";

export type Notification = { chatId: string; text: string; source: string };

export const NOTIFY_MAX_CHARS = 4000;

// File names sort in arrival order, even for notifications written in the same millisecond.
const nextName = monotonicFactory();

export function inboxDir(stateDir: string): string {
  return path.join(stateDir, "inbox");
}

export function writeNotification(stateDir: string, notification: Notification): string {
  const dir = inboxDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${nextName()}.json`);
  atomicWrite(file, `${JSON.stringify(notification)}\n`);
  return file;
}

// Pending notifications in arrival order. The caller deletes each file once it is delivered.
export function readInbox(stateDir: string): Array<{ file: string; notification: Notification }> {
  const dir = inboxDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  const pending: Array<{ file: string; notification: Notification }> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    try {
      const n = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Notification>;
      if (typeof n.chatId !== "string" || typeof n.text !== "string" || !n.text.trim()) throw new Error("missing chatId or text");
      pending.push({ file, notification: { chatId: n.chatId, text: n.text, source: n.source ?? "acmd notify" } });
    } catch (error) {
      log.warn("dropping malformed notification", { file: name, error: (error as Error).message });
      fs.rmSync(file, { force: true });
    }
  }
  return pending;
}

export function notificationNotice(n: Notification): string {
  return `[acmd] Notification (${n.source}):\n${n.text.trim()}`;
}
