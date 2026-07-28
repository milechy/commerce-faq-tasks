// admin-ui/src/components/AdminAgent/useFeedbackReplies.ts
// テナントの「相談窓口」: 担当者からの未読返信をポーリングし、
// FABバッジ・お返事カードの両方が同じ状態を参照できるようにする。
import { useCallback, useEffect, useState } from "react";
import { authFetch, API_BASE } from "../../lib/api";

export interface FeedbackReply {
  id: string;
  message: string;
  reply_body: string;
  replied_at: string | null;
}

const POLL_INTERVAL_MS = 60_000;

export function useFeedbackReplies(tenantId: string | null, isSuperAdmin: boolean) {
  const [replies, setReplies] = useState<FeedbackReply[]>([]);

  const fetchReplies = useCallback(async () => {
    if (!tenantId) {
      setReplies([]);
      return;
    }
    try {
      const params = new URLSearchParams({ unread: "true", limit: "5" });
      // super_admin のJWTにはtenant_idが無いため、プレビュー中も明示的に指定する
      if (isSuperAdmin) params.set("tenant_id", tenantId);
      const res = await authFetch(`${API_BASE}/v1/admin/feedback?${params}`);
      if (!res.ok) return;
      const data = (await res.json()) as { items: FeedbackReply[] };
      setReplies(data.items ?? []);
    } catch {
      // best-effort: バッジ更新は失敗しても致命的ではない
    }
  }, [tenantId, isSuperAdmin]);

  useEffect(() => {
    void fetchReplies();
    const timer = setInterval(() => void fetchReplies(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchReplies]);

  const markRead = useCallback(async (id: string) => {
    // 楽観的に即座にリストから消す
    setReplies((prev) => prev.filter((r) => r.id !== id));
    try {
      await authFetch(`${API_BASE}/v1/admin/feedback/${id}/read`, { method: "PATCH" });
    } catch {
      // best-effort: 既読化に失敗しても次回ポーリングで再取得されるだけ
    }
  }, []);

  return { replies, markRead, refetch: fetchReplies };
}

/** 「うまく解決しなかった」「まだ解決しません」共通の相談投稿ヘルパー */
export async function submitConsultation(params: {
  message: string;
  parentFeedbackId?: string;
}): Promise<boolean> {
  try {
    const res = await authFetch(`${API_BASE}/v1/admin/feedback`, {
      method: "POST",
      body: JSON.stringify({
        message: params.message,
        category: "other",
        ...(params.parentFeedbackId ? { parent_feedback_id: params.parentFeedbackId } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
