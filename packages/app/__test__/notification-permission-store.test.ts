import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasRequestedNotificationPermission,
  markNotificationPermissionRequested,
  notificationPermissionFile,
} from "../src/notification-permission-store.js";

test("hasRequestedNotificationPermission is false when no file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-notif-"));
  try {
    const requested = await hasRequestedNotificationPermission(notificationPermissionFile(dir));
    expect(requested).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markNotificationPermissionRequested then hasRequestedNotificationPermission round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-notif-"));
  try {
    const file = notificationPermissionFile(dir);
    await markNotificationPermissionRequested(file);
    expect(await hasRequestedNotificationPermission(file)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasRequestedNotificationPermission falls back to false on invalid file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-notif-"));
  try {
    const file = notificationPermissionFile(dir);
    await markNotificationPermissionRequested(file);
    await writeFile(file, "not json", "utf8");
    expect(await hasRequestedNotificationPermission(file)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
