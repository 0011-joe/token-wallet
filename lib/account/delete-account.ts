/**
 * M7/T7.2 注销删除（AC6-2）：删除用户与其全部关联数据，在调用方事务内执行。
 *
 * 删除面（schema 结构 + 临时库实测确认，见 tests/account-route.test.ts）：
 * - AlertEvent / UsageImport 没有 User 关系（模型里只有 userId 字段、无 relation），
 *   Prisma onDelete: Cascade 对它们不触发，必须手动 deleteMany；
 * - ApiKey / BalanceSnapshot / AlertSetting / Account / Session 由 onDelete: Cascade
 *   随 User 自动删除（better-sqlite3 adapter 下实测：user.delete 后三者计数均为 0）；
 * - VerificationToken 无 relation（按 email 的临时魔法链接令牌，随过期自然失效，非用户数据）。
 *
 * 「注销后不再被定时任务调用」（AC6-2 后半）：cron（GET/POST /api/cron/snapshot）遍历
 * isActive=true 的 ApiKey（app/api/cron/snapshot/route.ts），且本部署无本地调度器进程——
 * User 删除即其 ApiKey 行消失，任务自然不会再拉取该用户任何 Key。数据删除即任务失效，
 * 不需要额外的任务停止机制（超出本任务边界，见计划 R6）。
 */
import type { Prisma } from "@prisma/client";

export async function deleteAccount(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  // 无 User relation 的表：手动删（否则会留下孤立行）
  await tx.alertEvent.deleteMany({ where: { userId } });
  await tx.usageImport.deleteMany({ where: { userId } });
  // ApiKey/AlertSetting/Account/Session/快照 级联删除
  await tx.user.delete({ where: { id: userId } });
}
