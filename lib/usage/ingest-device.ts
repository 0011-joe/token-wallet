/**
 * 采集设备密钥（每设备独立，可吊销）。明文 key 仅创建时返回一次。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";

export function generateIngestKey(): string {
  return randomBytes(32).toString("base64url");
}

export function hashIngestKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface IngestDeviceView {
  id: string;
  name: string;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export async function createIngestDevice(userId: string, name: string) {
  const key = generateIngestKey();
  const device = await db.ingestDevice.create({
    data: { userId, name, keyHash: hashIngestKey(key) },
  });
  return {
    device: {
      id: device.id,
      name: device.name,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
      createdAt: device.createdAt,
    } satisfies IngestDeviceView,
    /** 仅此一次返回 */
    ingestKey: key,
  };
}

export async function listIngestDevices(userId: string): Promise<IngestDeviceView[]> {
  const rows = await db.ingestDevice.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      lastSeenAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return rows;
}

export async function revokeIngestDevice(userId: string, id: string): Promise<boolean> {
  const r = await db.ingestDevice.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return r.count > 0;
}

export async function findActiveDeviceByKey(
  userId: string,
  key: string
): Promise<{ id: string; name: string } | null> {
  const hash = hashIngestKey(key);
  const rows = await db.ingestDevice.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, name: true, keyHash: true },
  });
  for (const r of rows) {
    if (safeEqualHex(r.keyHash, hash)) return { id: r.id, name: r.name };
  }
  return null;
}

export async function touchDevice(id: string): Promise<void> {
  await db.ingestDevice
    .update({ where: { id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});
}
