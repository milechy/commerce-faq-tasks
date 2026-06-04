// admin-ui/src/components/knowledge/ExcludeSearchToggle.tsx
// Phase69-2-B (a): 検索除外チェックボックス — FAQ一覧行インライン切替
// 専用 PATCH /v1/admin/knowledge/faq/:id/exclude を呼ぶ。楽観的更新+エラー時ロールバック。

import { useState } from "react";
import { API_BASE } from "../../lib/api";
import { fetchWithAuth } from "./shared";

interface Props {
  faqId: number;
  tenantId: string;
  isExcluded: boolean;
  onToggled: (faqId: number, newValue: boolean) => void;
  onError: (message: string) => void;
}

export default function ExcludeSearchToggle({
  faqId,
  tenantId,
  isExcluded,
  onToggled,
  onError,
}: Props) {
  const [saving, setSaving] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saving) return;

    const nextValue = !isExcluded;

    // 楽観的更新
    onToggled(faqId, nextValue);
    setSaving(true);

    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/faq/${faqId}/exclude?tenant=${tenantId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_excluded_from_search: nextValue }),
        }
      );

      if (!res.ok) {
        // ロールバック
        onToggled(faqId, isExcluded);
        if (res.status === 409) {
          onError("他の処理中のため、少し時間をおいて再度お試しください");
        } else {
          onError("除外設定を保存できませんでした。ネットワークを確認してください");
        }
      }
    } catch {
      // ロールバック
      onToggled(faqId, isExcluded);
      onError("除外設定を保存できませんでした。ネットワークを確認してください");
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      disabled={saving}
      aria-label={isExcluded ? "検索除外を解除する" : "検索から除外する"}
      aria-pressed={isExcluded}
      title={isExcluded ? "クリックすると検索に戻します" : "クリックすると検索から除外します"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        minHeight: 44,
        minWidth: 44,
        borderRadius: 10,
        border: `1px solid ${
          isExcluded ? "rgba(239,68,68,0.5)" : "rgba(107,114,128,0.4)"
        }`,
        background: isExcluded
          ? "rgba(127,29,29,0.25)"
          : "rgba(31,41,55,0.4)",
        color: isExcluded ? "#f87171" : "#6b7280",
        fontSize: 12,
        fontWeight: 600,
        cursor: saving ? "not-allowed" : "pointer",
        opacity: saving ? 0.6 : 1,
        transition: "all 0.15s",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {saving ? (
        <span
          style={{
            width: 12,
            height: 12,
            border: "2px solid rgba(255,255,255,0.3)",
            borderTopColor: isExcluded ? "#f87171" : "#6b7280",
            borderRadius: "50%",
            display: "inline-block",
            animation: "spin 0.8s linear infinite",
          }}
        />
      ) : (
        <span style={{ fontSize: 14 }}>{isExcluded ? "🚫" : "✅"}</span>
      )}
      {isExcluded ? "除外中" : "検索対象"}
    </button>
  );
}
