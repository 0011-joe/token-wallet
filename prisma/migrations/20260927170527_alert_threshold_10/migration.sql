-- 低余额默认阈值 20 → 10（DeepSeek 余额低于 10 才提醒）
ALTER TABLE "AlertSetting" ALTER COLUMN "lowBalanceThreshold" SET DEFAULT 10;
