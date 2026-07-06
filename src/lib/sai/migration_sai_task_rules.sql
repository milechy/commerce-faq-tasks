-- Phase6 (Sai Judge学習ループ): sai_task_rules テーブル
-- tuning_rules(チャットAI用)と同型のパターンだが、GUI操作エージェントへの
-- 指示注入用に別テーブルとして新設する(Hermes/Sai Judgeの分離方針と同じ理由)。
--
-- tuning_rulesの運用で判明した注意点(is_activeがsource='judge'挿入時に
-- デフォルトtrueになり承認前から有効化されてしまう問題)を踏まえ、
-- sai_task_rulesでは is_active を明示的に false スタートにする。
-- 実際にAgent Sへ注入されるのは is_active=true になった行のみ。

CREATE TABLE IF NOT EXISTS sai_task_rules (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,                    -- 'global' = 全テナント共通
  trigger_pattern TEXT NOT NULL,               -- カンマ区切りキーワード。option_orders.descriptionとの一致判定に使う
  expected_behavior TEXT NOT NULL,             -- Agent Sへの指示に注入するガイダンス文
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT false,    -- 承認されるまで注入しない
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | active | rejected
  source TEXT NOT NULL DEFAULT 'sai_judge',    -- sai_judge(自動提案) | manual
  evidence JSONB,                              -- 提案の根拠(該当タスクID・アウトカム等)
  created_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sai_task_rules_status CHECK (status IN ('pending', 'active', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_sai_task_rules_tenant ON sai_task_rules(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sai_task_rules_status ON sai_task_rules(status);
