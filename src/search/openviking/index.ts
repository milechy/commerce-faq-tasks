// src/search/openviking/index.ts
// Phase47: OpenViking Feature Flag エントリポイント
//
// 環境変数:
//   OPENVIKING_ENABLED=1   → OpenViking 経由を有効化
//   OPENVIKING_URL         → OpenViking HTTP API URL（デフォルト: http://localhost:18789）
//   OPENVIKING_TENANTS     → 有効化テナントをカンマ区切りで指定（省略時: 全テナント）
//                            例: OPENVIKING_TENANTS=carnation
//
// 使用方法（principleSearch.ts 内で差し替え）:
//   import { isOpenVikingEnabled, searchPrincipleChunksViaOpenViking } from '../search/openviking';

export { searchPrincipleChunksViaOpenViking } from './openVikingAdapter';
export { ovSearch, ovProgressiveLoad } from './openVikingClient';

const ENABLED_TENANTS = (process.env.OPENVIKING_TENANTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * 指定テナントでOpenVikingが有効かどうかを確認する。
 * OPENVIKING_ENABLED=1 かつ（OPENVIKING_TENANTS未設定 or テナントが一覧に含まれる）場合に true。
 */
function isOpenVikingEnabled(tenantId: string): boolean {
  if (process.env.OPENVIKING_ENABLED !== '1') return false;
  if (ENABLED_TENANTS.length === 0) return true;
  return ENABLED_TENANTS.includes(tenantId);
}
