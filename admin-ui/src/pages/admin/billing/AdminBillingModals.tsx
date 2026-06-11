import type { Tenant } from "./types";

interface AdminBillingModalsProps {
  adjustModalOpen: boolean;
  setAdjustModalOpen: (open: boolean) => void;
  adjustType: "discount" | "add";
  setAdjustType: (type: "discount" | "add") => void;
  adjustAmount: string;
  setAdjustAmount: (value: string) => void;
  adjustReason: string;
  setAdjustReason: (value: string) => void;
  adjustLoading: boolean;
  handleAdjust: () => Promise<void>;
  freePeriodModalOpen: boolean;
  setFreePeriodModalOpen: (open: boolean) => void;
  freeFrom: string;
  setFreeFrom: (value: string) => void;
  freeUntil: string;
  setFreeUntil: (value: string) => void;
  freePeriodLoading: boolean;
  handleFreePeriod: () => Promise<void>;
  tenants: Tenant[];
  selectedTenantId: string;
}

export function AdminBillingModals({
  adjustModalOpen,
  setAdjustModalOpen,
  adjustType,
  setAdjustType,
  adjustAmount,
  setAdjustAmount,
  adjustReason,
  setAdjustReason,
  adjustLoading,
  handleAdjust,
  freePeriodModalOpen,
  setFreePeriodModalOpen,
  freeFrom,
  setFreeFrom,
  freeUntil,
  setFreeUntil,
  freePeriodLoading,
  handleFreePeriod,
  tenants,
  selectedTenantId,
}: AdminBillingModalsProps) {
  return (
    <>
      {/* 金額調整モーダル */}
      {adjustModalOpen && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 3000,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setAdjustModalOpen(false); }}
        >
          <div style={{
            background: "linear-gradient(145deg,#0f172a,#1e293b)",
            border: "1px solid #334155", borderRadius: 16,
            padding: "28px 24px", width: "100%", maxWidth: 440,
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 18, fontWeight: 700, color: "var(--foreground)" }}>💰 金額調整</h3>

            {/* タイプ切替 */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button
                onClick={() => setAdjustType("discount")}
                style={{
                  flex: 1, padding: "10px 0", minHeight: 44, borderRadius: 10,
                  border: `1px solid ${adjustType === "discount" ? "rgba(168,85,247,0.5)" : "#374151"}`,
                  background: adjustType === "discount" ? "rgba(168,85,247,0.15)" : "transparent",
                  color: adjustType === "discount" ? "#d8b4fe" : "#9ca3af",
                  fontWeight: 700, fontSize: 14, cursor: "pointer",
                }}
              >▼ 割引（値引き）</button>
              <button
                onClick={() => setAdjustType("add")}
                style={{
                  flex: 1, padding: "10px 0", minHeight: 44, borderRadius: 10,
                  border: `1px solid ${adjustType === "add" ? "rgba(239,68,68,0.5)" : "#374151"}`,
                  background: adjustType === "add" ? "rgba(239,68,68,0.15)" : "transparent",
                  color: adjustType === "add" ? "#f87171" : "#9ca3af",
                  fontWeight: 700, fontSize: 14, cursor: "pointer",
                }}
              >▲ 追加請求</button>
            </div>

            {/* 金額 */}
            <label style={{ display: "block", fontSize: 13, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
              金額（円）
            </label>
            <input
              type="number"
              min="1"
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
              placeholder="例: 1000"
              style={{
                width: "100%", padding: "12px 14px", minHeight: 44, borderRadius: 10,
                border: "1px solid var(--border)", background: "rgba(0,0,0,0.3)",
                color: "var(--foreground)", fontSize: 15, boxSizing: "border-box", marginBottom: 16,
              }}
            />

            {/* 理由 */}
            <label style={{ display: "block", fontSize: 13, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
              理由（必須）
            </label>
            <textarea
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              placeholder="調整の理由を入力してください"
              rows={3}
              style={{
                width: "100%", padding: "12px 14px", borderRadius: 10,
                border: "1px solid var(--border)", background: "rgba(0,0,0,0.3)",
                color: "var(--foreground)", fontSize: 14, resize: "vertical",
                boxSizing: "border-box", marginBottom: 20, fontFamily: "inherit",
              }}
            />

            {/* プレビュー */}
            {adjustAmount && parseInt(adjustAmount, 10) > 0 && (
              <div style={{
                padding: "12px 16px", borderRadius: 10, marginBottom: 20,
                background: adjustType === "discount" ? "rgba(168,85,247,0.1)" : "rgba(239,68,68,0.1)",
                border: `1px solid ${adjustType === "discount" ? "rgba(168,85,247,0.3)" : "rgba(239,68,68,0.3)"}`,
                fontSize: 14, color: adjustType === "discount" ? "#d8b4fe" : "#f87171", fontWeight: 600,
              }}>
                {adjustType === "discount"
                  ? `¥${parseInt(adjustAmount, 10).toLocaleString("ja-JP")} を割引します`
                  : `¥${parseInt(adjustAmount, 10).toLocaleString("ja-JP")} を追加請求します`}
              </div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setAdjustModalOpen(false)}
                style={{
                  flex: 1, padding: "12px 0", minHeight: 44, borderRadius: 10,
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--muted-foreground)", fontSize: 15, fontWeight: 600, cursor: "pointer",
                }}
              >キャンセル</button>
              <button
                onClick={() => void handleAdjust()}
                disabled={adjustLoading || !adjustAmount || !adjustReason.trim()}
                style={{
                  flex: 1, padding: "12px 0", minHeight: 44, borderRadius: 10, border: "none",
                  background: adjustLoading || !adjustAmount || !adjustReason.trim()
                    ? "#374151" : "linear-gradient(135deg,#a855f7,#7c3aed)",
                  color: adjustLoading || !adjustAmount || !adjustReason.trim() ? "#6b7280" : "#fff",
                  fontSize: 15, fontWeight: 700,
                  cursor: adjustLoading || !adjustAmount || !adjustReason.trim() ? "not-allowed" : "pointer",
                }}
              >{adjustLoading ? "送信中..." : "調整を送信"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 無料期間設定モーダル */}
      {freePeriodModalOpen && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 3000,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setFreePeriodModalOpen(false); }}
        >
          <div style={{
            background: "linear-gradient(145deg,#0f172a,#1e293b)",
            border: "1px solid #334155", borderRadius: 16,
            padding: "28px 24px", width: "100%", maxWidth: 400,
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 18, fontWeight: 700, color: "var(--foreground)" }}>🎁 無料期間の設定</h3>

            {/* 現在の設定 */}
            {(() => {
              const st = tenants.find((t) => t.id === selectedTenantId);
              if (st?.billing_free_from || st?.billing_free_until) {
                return (
                  <div style={{
                    padding: "10px 14px", borderRadius: 10, marginBottom: 20,
                    background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)",
                    fontSize: 13, color: "#fcd34d",
                  }}>
                    現在の設定:{" "}
                    {st.billing_free_from ? st.billing_free_from.slice(0, 10) : "—"}
                    {" 〜 "}
                    {st.billing_free_until ? st.billing_free_until.slice(0, 10) : "—"}
                  </div>
                );
              }
              return null;
            })()}

            {/* 開始日 */}
            <label style={{ display: "block", fontSize: 13, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
              開始日
            </label>
            <input
              type="date"
              value={freeFrom}
              onChange={(e) => setFreeFrom(e.target.value)}
              style={{
                width: "100%", padding: "12px 14px", minHeight: 44, borderRadius: 10,
                border: "1px solid var(--border)", background: "rgba(0,0,0,0.3)",
                color: "var(--foreground)", fontSize: 15, boxSizing: "border-box", marginBottom: 16,
              }}
            />

            {/* 終了日 */}
            <label style={{ display: "block", fontSize: 13, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
              終了日
            </label>
            <input
              type="date"
              value={freeUntil}
              onChange={(e) => setFreeUntil(e.target.value)}
              style={{
                width: "100%", padding: "12px 14px", minHeight: 44, borderRadius: 10,
                border: "1px solid var(--border)", background: "rgba(0,0,0,0.3)",
                color: "var(--foreground)", fontSize: 15, boxSizing: "border-box", marginBottom: 8,
              }}
            />
            <p style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 20 }}>
              空欄にすると設定を解除します
            </p>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setFreePeriodModalOpen(false)}
                style={{
                  flex: 1, padding: "12px 0", minHeight: 44, borderRadius: 10,
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--muted-foreground)", fontSize: 15, fontWeight: 600, cursor: "pointer",
                }}
              >キャンセル</button>
              <button
                onClick={() => void handleFreePeriod()}
                disabled={freePeriodLoading}
                style={{
                  flex: 1, padding: "12px 0", minHeight: 44, borderRadius: 10, border: "none",
                  background: freePeriodLoading ? "#374151" : "linear-gradient(135deg,#f59e0b,#d97706)",
                  color: freePeriodLoading ? "#6b7280" : "#1a0a00",
                  fontSize: 15, fontWeight: 700,
                  cursor: freePeriodLoading ? "not-allowed" : "pointer",
                }}
              >{freePeriodLoading ? "保存中..." : "保存する"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
