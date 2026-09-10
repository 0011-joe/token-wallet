/**
 * 注销删除（AC6-2）：删除用户与其全部关联数据，在调用方事务内执行。
 *
 * 删除面（v2 schema）：
 * - AlertEvent / AlertOverride / UsageImport 有 userId 但 AlertOverride 有 User relation
 *   （onDelete: Cascade）；AlertEvent / UsageImport 无 relation，必须手动 deleteMany；
 * - Credential / BalanceSnapshot / AlertSetting / Account / Session 由 onDelete: Cascade
 *   随 User 自动删除；
 * - VerificationToken 无 relation（临时魔法链接令牌，随过期自然失效）。
 * 「注销后不再被定时任务调用」：cron 遍历 isActive Credential，User 删除即其 Credential
 * 行消失，任务自然不会再拉取。
 */
import type { Prisma } from "@prisma/client";

export async function deleteAccount(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  // 无 User relation 的表：手动删（否则会留下孤立行）
  await tx.alertEvent.deleteMany({ where: { userId } });
  await tx.usageImport.deleteMany({ where: { userId } });
  // Credential/快照/AlertSetting/AlertOverride/Account/Session 级联删除
  await tx.user.delete({ where: { id: userId } });
}
