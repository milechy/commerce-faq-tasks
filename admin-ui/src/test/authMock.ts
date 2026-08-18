import { vi } from "vitest";
import type { useAuth } from "../auth/useAuth";

// useAuth.tsx の AuthContextValue は非export（useAuthの戻り値としてのみ公開）。
// 製品コードを型のためだけに変更しないため、ReturnType で同じ形を導出する。
type AuthContextValue = ReturnType<typeof useAuth>;

/**
 * AuthContextValue の完全なモックを返す factory。
 * 各テストは差分（overrides）だけ渡す。フィールド追加のたびに全テストの
 * モックが個別に壊れる（as によるすり抜け）のを防ぐのが目的。
 */
export function createAuthMock(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    isLoading: false,
    isSuperAdmin: false,
    isClientAdmin: false,
    logout: vi.fn(),
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    enterPreview: vi.fn(),
    exitPreview: vi.fn(),
    tenantPlan: null,
    onboardingStage: null,
    onboardingStageResolved: true,
    ...overrides,
  };
}
