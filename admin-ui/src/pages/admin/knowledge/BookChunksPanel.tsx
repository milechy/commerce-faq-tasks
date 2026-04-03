// admin-ui/src/pages/admin/knowledge/BookChunksPanel.tsx
// B-1: 書籍チャンク詳細パネル（モーダル）
// - チャンク一覧表示（カード形式、スクロール可能）
// - 6フィールドインライン編集
// - 削除（確認ダイアログ付き）
// Anti-Slop: テキストは200文字上限（API側で保証済み）、console.logにチャンク内容を含めない

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { fetchWithAuth } from "../../../components/knowledge/shared";
import { API_BASE } from "../../../lib/api";

// ─── 型定義 ────────────────────────────────────────────────────────────────────

interface ChunkMetadata {
  source?: string;
  book_id?: string | number;
  page_number?: number | null;
  situation?: string | null;
  resistance?: string | null;
  principle?: string | null;
  contraindication?: string | null;
  example?: string | null;
  failure_example?: string | null;
}

interface BookChunk {
  id: number;
  text: string; // ≤200文字（API側でslice済み）
  metadata: ChunkMetadata;
  is_structured: boolean;
  created_at: string;
}

interface Props {
  bookId: number;
  bookTitle: string;
  bookStatus: string;
  tenantId: string;
  onClose: () => void;
  onChunkDeleted?: () => void;
}

// ─── 定数 ──────────────────────────────────────────────────────────────────────

const ALLOWED_FIELDS = [
  "situation",
  "resistance",
  "principle",
  "contraindication",
  "example",
  "failure_example",
] as const;
type AllowedField = (typeof ALLOWED_FIELDS)[number];

const FIELD_LABELS: Record<AllowedField, string> = {
  situation: "状況",
  resistance: "抵抗",
  principle: "原則",
  contraindication: "禁忌",
  example: "例",
  failure_example: "失敗例",
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "アップロード済",
  processing: "処理中",
  chunked: "分割完了",
  embedded: "埋め込み完了",
  failed: "失敗",
};

const STATUS_COLOR: Record<string, string> = {
  uploaded: "#9ca3af",
  processing: "#60a5fa",
  chunked: "#a78bfa",
  embedded: "#4ade80",
  failed: "#f87171",
};

// ─── スタイル定数 ────────────────────────────────────────────────────────────────

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.75)",
  zIndex: 1000,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "24px 16px",
  overflowY: "auto",
};

const PANEL: CSSProperties = {
  width: "100%",
  maxWidth: 640,
  borderRadius: 16,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, #0f172a, #020617)",
  color: "#e5e7eb",
  display: "flex",
  flexDirection: "column",
  maxHeight: "90vh",
  overflowY: "hidden",
};

const TEXTAREA_SM: CSSProperties = {
  width: "100%",
  minHeight: 64,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 14,
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};

// ─── メインコンポーネント ────────────────────────────────────────────────────────

export default function BookChunksPanel({
  bookId,
  bookTitle,
  bookStatus,
  onClose,
  onChunkDeleted,
}: Props) {
  const [chunks, setChunks] = useState<BookChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 編集状態
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFields, setEditFields] = useState<Record<AllowedField, string>>({
    situation: "",
    resistance: "",
    principle: "",
    contraindication: "",
    example: "",
    failure_example: "",
  });
  const [saving, setSaving] = useState(false);

  // 削除状態
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  // トースト
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  // ─── チャンク読み込み ────────────────────────────────────────────────────────

  const loadChunks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf/${bookId}/chunks`
      );
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "分割テキストの取得に失敗しました");
        return;
      }
      const data = (await res.json()) as { chunks?: BookChunk[] };
      setChunks(data.chunks ?? []);
    } catch {
      setError("分割テキストの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void loadChunks();
  }, [loadChunks]);

  // ─── 編集 ───────────────────────────────────────────────────────────────────

  const startEdit = (chunk: BookChunk) => {
    const fields = {} as Record<AllowedField, string>;
    for (const f of ALLOWED_FIELDS) {
      fields[f] = (chunk.metadata[f] as string | null | undefined) ?? "";
    }
    setEditFields(fields);
    setEditingId(chunk.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const handleSave = async (chunkId: number) => {
    setSaving(true);
    try {
      const body: Record<string, string | null> = {};
      for (const f of ALLOWED_FIELDS) {
        body[f] = editFields[f].trim() || null;
      }
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf/chunks/${chunkId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        showToast(d.error ?? "保存に失敗しました", false);
        return;
      }
      showToast("チャンクを更新しました", true);
      setEditingId(null);
      void loadChunks();
    } catch {
      showToast("保存に失敗しました", false);
    } finally {
      setSaving(false);
    }
  };

  // ─── 削除 ───────────────────────────────────────────────────────────────────

  const confirmDelete = async (chunkId: number) => {
    setDeleting(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf/chunks/${chunkId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        showToast(d.error ?? "削除に失敗しました", false);
        return;
      }
      showToast("分割テキストを削除しました", true);
      setDeletingId(null);
      void loadChunks();
      onChunkDeleted?.();
    } catch {
      showToast("削除に失敗しました", false);
    } finally {
      setDeleting(false);
    }
  };

  // ─── レンダー ────────────────────────────────────────────────────────────────

  const statusBadgeStyle = (status: string): CSSProperties => {
    const color = STATUS_COLOR[status] ?? "#9ca3af";
    return {
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: `${color}22`,
      border: `1px solid ${color}55`,
      color,
    };
  };

  return (
    <div style={OVERLAY} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        {/* トースト */}
        {toast && (
          <div
            style={{
              position: "fixed",
              top: 20,
              right: 20,
              zIndex: 9999,
              padding: "12px 20px",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              background: toast.ok ? "rgba(5,46,22,0.95)" : "rgba(127,29,29,0.95)",
              border: `1px solid ${toast.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
              color: toast.ok ? "#86efac" : "#fca5a5",
            }}
          >
            {toast.msg}
          </div>
        )}

        {/* ヘッダー */}
        <div
          style={{
            padding: "20px 20px 16px",
            borderBottom: "1px solid #1f2937",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#f9fafb",
                wordBreak: "break-word",
              }}
            >
              📚 {bookTitle}
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={statusBadgeStyle(bookStatus)}>
                {STATUS_LABEL[bookStatus] ?? bookStatus}
              </span>
              {!loading && (
                <span style={{ fontSize: 13, color: "#6b7280" }}>
                  {chunks.length}件の分割テキスト
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: "8px 14px",
              minHeight: 44,
              minWidth: 44,
              borderRadius: 8,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 14,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* チャンク一覧 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 20px" }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: "#6b7280" }}>
              読み込み中...
            </div>
          ) : error ? (
            <div
              style={{
                padding: "14px 16px",
                borderRadius: 10,
                background: "rgba(127,29,29,0.3)",
                border: "1px solid rgba(248,113,113,0.3)",
                color: "#fca5a5",
                fontSize: 14,
              }}
            >
              {error}
            </div>
          ) : chunks.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                borderRadius: 12,
                border: "1px dashed #374151",
                color: "#6b7280",
                fontSize: 14,
              }}
            >
              分割テキストがまだありません
              <div style={{ fontSize: 12, marginTop: 8 }}>
                PDFを処理すると分割テキストが生成されます
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {chunks.map((chunk) => (
                <ChunkCard
                  key={chunk.id}
                  chunk={chunk}
                  isEditing={editingId === chunk.id}
                  editFields={editFields}
                  saving={saving}
                  deletingId={deletingId}
                  deleting={deleting}
                  onStartEdit={() => startEdit(chunk)}
                  onCancelEdit={cancelEdit}
                  onEditFieldChange={(field, val) =>
                    setEditFields((prev) => ({ ...prev, [field]: val }))
                  }
                  onSave={() => void handleSave(chunk.id)}
                  onDeleteRequest={() => setDeletingId(chunk.id)}
                  onDeleteCancel={() => setDeletingId(null)}
                  onDeleteConfirm={() => void confirmDelete(chunk.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── チャンクカード ────────────────────────────────────────────────────────────

interface ChunkCardProps {
  chunk: BookChunk;
  isEditing: boolean;
  editFields: Record<AllowedField, string>;
  saving: boolean;
  deletingId: number | null;
  deleting: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditFieldChange: (field: AllowedField, val: string) => void;
  onSave: () => void;
  onDeleteRequest: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
}

function ChunkCard({
  chunk,
  isEditing,
  editFields,
  saving,
  deletingId,
  deleting,
  onStartEdit,
  onCancelEdit,
  onEditFieldChange,
  onSave,
  onDeleteRequest,
  onDeleteCancel,
  onDeleteConfirm,
}: ChunkCardProps) {
  const isDeleting = deletingId === chunk.id;

  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${isEditing ? "rgba(74,222,128,0.3)" : "#1f2937"}`,
        background: isEditing
          ? "rgba(5,46,22,0.15)"
          : "rgba(15,23,42,0.6)",
        padding: "14px 16px",
        transition: "border-color 0.15s",
      }}
    >
      {/* チャンクヘッダー */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          marginBottom: isEditing || isDeleting ? 12 : 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* テキストプレビュー（≤200文字、展開不可） */}
          <div
            style={{
              fontSize: 13,
              color: "#d1d5db",
              lineHeight: 1.6,
              wordBreak: "break-word",
              marginBottom: 8,
            }}
          >
            {chunk.text}
          </div>

          {/* バッジ行 */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {chunk.metadata.page_number != null && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "rgba(96,165,250,0.15)",
                  border: "1px solid rgba(96,165,250,0.3)",
                  color: "#60a5fa",
                }}
              >
                p.{chunk.metadata.page_number}
              </span>
            )}
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                background: chunk.is_structured
                  ? "rgba(74,222,128,0.1)"
                  : "rgba(107,114,128,0.15)",
                border: `1px solid ${chunk.is_structured ? "rgba(74,222,128,0.3)" : "rgba(107,114,128,0.3)"}`,
                color: chunk.is_structured ? "#4ade80" : "#9ca3af",
              }}
            >
              {chunk.is_structured ? "✅ 構造化済み" : "⬜ 未構造化"}
            </span>
          </div>
        </div>

        {/* 操作ボタン（編集・削除中は非表示） */}
        {!isEditing && !isDeleting && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              onClick={onStartEdit}
              style={{
                padding: "8px 14px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              編集
            </button>
            <button
              onClick={onDeleteRequest}
              style={{
                padding: "8px 14px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #7f1d1d",
                background: "rgba(127,29,29,0.15)",
                color: "#fca5a5",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              削除
            </button>
          </div>
        )}
      </div>

      {/* 削除確認 */}
      {isDeleting && (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 10,
            background: "rgba(127,29,29,0.2)",
            border: "1px solid rgba(248,113,113,0.25)",
            marginTop: 4,
          }}
        >
          <div style={{ fontSize: 14, color: "#fca5a5", marginBottom: 12, fontWeight: 600 }}>
            この分割テキストを削除しますか？元に戻せません。
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onDeleteCancel}
              disabled={deleting}
              style={{
                flex: 1,
                padding: "12px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 14,
                fontWeight: 600,
                cursor: deleting ? "not-allowed" : "pointer",
              }}
            >
              キャンセル
            </button>
            <button
              onClick={onDeleteConfirm}
              disabled={deleting}
              style={{
                flex: 1,
                padding: "12px",
                minHeight: 44,
                borderRadius: 8,
                border: "none",
                background: deleting ? "#1f2937" : "#7f1d1d",
                color: deleting ? "#6b7280" : "#fca5a5",
                fontSize: 14,
                fontWeight: 700,
                cursor: deleting ? "not-allowed" : "pointer",
              }}
            >
              {deleting ? "削除中..." : "削除する"}
            </button>
          </div>
        </div>
      )}

      {/* 6フィールド編集フォーム */}
      {isEditing && (
        <div style={{ marginTop: 4 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginBottom: 12,
            }}
          >
            {ALLOWED_FIELDS.map((field) => (
              <div key={field}>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: "#9ca3af",
                    marginBottom: 4,
                    fontWeight: 600,
                  }}
                >
                  {FIELD_LABELS[field]}
                </label>
                <textarea
                  rows={2}
                  value={editFields[field]}
                  onChange={(e) => onEditFieldChange(field, e.target.value)}
                  disabled={saving}
                  style={{
                    ...TEXTAREA_SM,
                    opacity: saving ? 0.7 : 1,
                  }}
                />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancelEdit}
              disabled={saving}
              style={{
                flex: 1,
                padding: "12px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 14,
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              キャンセル
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              style={{
                flex: 2,
                padding: "12px",
                minHeight: 44,
                borderRadius: 8,
                border: "none",
                background: saving
                  ? "#1f2937"
                  : "linear-gradient(135deg, #22c55e, #4ade80)",
                color: saving ? "#6b7280" : "#022c22",
                fontSize: 14,
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
