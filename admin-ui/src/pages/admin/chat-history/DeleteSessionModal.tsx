import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DeleteStep } from "./types";

// ─── 完全削除モーダル（GDPR Art.17 / 個情法30条） ──────────────────────────────

export function DeleteSessionModal({
  deleteStep,
  setDeleteStep,
  deleteReason,
  setDeleteReason,
  deleteConfirmId,
  setDeleteConfirmId,
  deleteSubmitting,
  deleteError,
  setDeleteError,
  deleteReasonRef,
  deleteConfirmRef,
  sessionId,
  handleDeleteSubmit,
}: {
  deleteStep: DeleteStep;
  setDeleteStep: Dispatch<SetStateAction<DeleteStep>>;
  deleteReason: string;
  setDeleteReason: Dispatch<SetStateAction<string>>;
  deleteConfirmId: string;
  setDeleteConfirmId: Dispatch<SetStateAction<string>>;
  deleteSubmitting: boolean;
  deleteError: string | null;
  setDeleteError: Dispatch<SetStateAction<string | null>>;
  deleteReasonRef: RefObject<HTMLTextAreaElement | null>;
  deleteConfirmRef: RefObject<HTMLInputElement | null>;
  sessionId: string | undefined;
  handleDeleteSubmit: () => Promise<void>;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="セッション完全削除"
      onClick={(e) => {
        if (e.target === e.currentTarget && !deleteSubmitting) {
          setDeleteStep("idle");
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 20,
      }}
    >
      <div
        style={{
          background: "var(--background)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: "28px 24px",
          maxWidth: 480,
          width: "100%",
        }}
      >
        {/* エラー表示 */}
        {deleteError && (
          <div
            style={{
              marginBottom: 16,
              padding: "12px 16px",
              borderRadius: 10,
              background: "rgba(127,29,29,0.4)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#fca5a5",
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            {deleteError}
          </div>
        )}

        {/* Step 1: 警告・確認 */}
        {deleteStep === "step1" && (
          <>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
              🗑️ セッションを完全に削除しますか?
            </h2>
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                background: "rgba(120,53,15,0.4)",
                border: "1px solid rgba(251,191,36,0.3)",
                color: "#fbbf24",
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 20,
                lineHeight: 1.6,
              }}
            >
              ⚠️ この操作は取り消せません。チャット履歴・評価データがすべて完全に削除されます。
            </div>
            <p style={{ fontSize: 15, color: "var(--muted-foreground)", marginBottom: 24, lineHeight: 1.6 }}>
              GDPR（忘れられる権利）または個人情報保護法に基づいて削除を行う場合は「次へ」を押してください。
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <button
                onClick={() => {
                  setDeleteError(null);
                  setDeleteStep("step2");
                  setTimeout(() => deleteReasonRef.current?.focus(), 50);
                }}
                style={{
                  padding: "16px 24px",
                  minHeight: 52,
                  borderRadius: 12,
                  border: "1px solid rgba(239,68,68,0.5)",
                  background: "rgba(127,29,29,0.3)",
                  color: "#f87171",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                次へ（削除理由を入力）
              </button>
              <button
                onClick={() => setDeleteStep("idle")}
                style={{
                  padding: "14px 24px",
                  minHeight: 48,
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--muted-foreground)",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                やめる
              </button>
            </div>
          </>
        )}

        {/* Step 2: 削除理由入力 + セッションID確認 */}
        {deleteStep === "step2" && (
          <>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
              削除の詳細確認
            </h2>

            {/* 削除理由 */}
            <div style={{ marginBottom: 20 }}>
              <label
                htmlFor="delete-reason"
                style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}
              >
                削除理由 <span style={{ color: "#f87171" }}>*</span>
                <span style={{ fontWeight: 400, color: "var(--muted-foreground)", marginLeft: 4 }}>(5〜500文字)</span>
              </label>
              <textarea
                id="delete-reason"
                ref={deleteReasonRef}
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="例: GDPR Art.17に基づくデータ削除要求（ユーザーID: xxx、受付日: 2026-05-31）"
                rows={4}
                disabled={deleteSubmitting}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--foreground)",
                  fontSize: 14,
                  lineHeight: 1.6,
                  resize: "vertical",
                  minHeight: 96,
                  boxSizing: "border-box",
                  outline: "none",
                }}
              />
              <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                {deleteReason.trim().length} / 500文字
              </span>
            </div>

            {/* セッションID確認 */}
            <div style={{ marginBottom: 24 }}>
              <label
                htmlFor="delete-confirm-id"
                style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}
              >
                確認のため、セッションIDを入力してください <span style={{ color: "#f87171" }}>*</span>
              </label>
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                  background: "rgba(0,0,0,0.4)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "6px 10px",
                  marginBottom: 8,
                  wordBreak: "break-all",
                  userSelect: "text",
                }}
              >
                {sessionId}
              </div>
              <input
                id="delete-confirm-id"
                ref={deleteConfirmRef}
                type="text"
                value={deleteConfirmId}
                onChange={(e) => setDeleteConfirmId(e.target.value)}
                placeholder="上記のセッションIDをそのまま入力"
                disabled={deleteSubmitting}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border:
                    deleteConfirmId && deleteConfirmId !== sessionId
                      ? "1px solid rgba(248,113,113,0.5)"
                      : "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--foreground)",
                  fontSize: 14,
                  fontFamily: "monospace",
                  boxSizing: "border-box",
                  outline: "none",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <button
                onClick={() => void handleDeleteSubmit()}
                disabled={
                  deleteSubmitting ||
                  deleteReason.trim().length < 5 ||
                  deleteConfirmId.trim() !== sessionId
                }
                style={{
                  padding: "16px 24px",
                  minHeight: 52,
                  borderRadius: 12,
                  border: "1px solid rgba(239,68,68,0.5)",
                  background:
                    deleteSubmitting ||
                    deleteReason.trim().length < 5 ||
                    deleteConfirmId.trim() !== sessionId
                      ? "rgba(127,29,29,0.2)"
                      : "rgba(127,29,29,0.5)",
                  color:
                    deleteSubmitting ||
                    deleteReason.trim().length < 5 ||
                    deleteConfirmId.trim() !== sessionId
                      ? "rgba(248,113,113,0.5)"
                      : "#f87171",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor:
                    deleteSubmitting ||
                    deleteReason.trim().length < 5 ||
                    deleteConfirmId.trim() !== sessionId
                      ? "not-allowed"
                      : "pointer",
                  width: "100%",
                }}
              >
                {deleteSubmitting ? "⏳ 削除中..." : "🗑️ 完全に削除する"}
              </button>
              <button
                onClick={() => {
                  setDeleteError(null);
                  setDeleteStep("step1");
                }}
                disabled={deleteSubmitting}
                style={{
                  padding: "14px 24px",
                  minHeight: 48,
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--muted-foreground)",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: deleteSubmitting ? "not-allowed" : "pointer",
                  width: "100%",
                }}
              >
                戻る
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
