-- Phase64 タスク6: option_orders拡張マイグレーション
-- result_url: 納品物URL（プレミアムアバター制作代行の完成画像など）
-- type: 注文種別（'general' | 'premium_avatar'）

ALTER TABLE option_orders
  ADD COLUMN IF NOT EXISTS result_url TEXT,
  ADD COLUMN IF NOT EXISTS type VARCHAR(50) NOT NULL DEFAULT 'general';

-- 既存レコードは 'general' のまま
-- premium_avatar 注文は type='premium_avatar' で作成される
