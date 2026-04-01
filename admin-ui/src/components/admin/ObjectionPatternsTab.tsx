import { useState } from "react";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface ObjectionPattern {
  id: string;
  trigger_phrase: string;
  response_strategy: string;
  principle: string;
  success_rate: number;
  total_count: number;
}

// ─── モックデータ ─────────────────────────────────────────────────────────────

const MOCK_PATTERNS: ObjectionPattern[] = [
  {
    id: "op1",
    trigger_phrase: "「高い」系の反論",
    response_strategy: "価値を先に説明してからアンカリング",
    principle: "アンカリング効果",
    success_rate: 78,
    total_count: 12,
  },
  {
    id: "op2",
    trigger_phrase: "「他社が安い」系の反論",
    response_strategy: "差別化ポイント3つ提示",
    principle: "社会的証明",
    success_rate: 72,
    total_count: 9,
  },
  {
    id: "op3",
    trigger_phrase: "「検討します」系の反論",
    response_strategy: "具体的な懸念点を引き出す質問",
    principle: "返報性の原則",
    success_rate: 65,
    total_count: 17,
  },
];

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "16px 18px",
  marginBottom: 10,
};

const BTN_DANGER: React.CSSProperties = {
  padding: "8px 12px",
  minHeight: 44,
  minWidth: 44,
  borderRadius: 8,
  border: "1px solid rgba(239,68,68,0.3)",
  background: "transparent",
  color: "#f87171",
  fontSize: 16,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

// ─── 反論パターンタブ ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function ObjectionPatternsTab({ tenantId: _tenantId }: { tenantId: string }) {
  const [patterns, setPatterns] = useState<ObjectionPattern[]>(MOCK_PATTERNS);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleDelete = (id: string) => {
    // TODO: DELETE ${API_BASE}/v1/admin/tenants/${tenantId}/objection-patterns/${id}
    setPatterns((prev) => prev.filter((p) => p.id !== id));
    showToast("🗑 反論パターンを削除しました");
  };

  return (
    <div>
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "14px 24px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.98)",
            border: "1px solid #22c55e",
            color: "#4ade80",
            fontSize: 15,
            fontWeight: 600,
            zIndex: 4000,
            whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 8px" }}>
          反論パターン一覧
        </h3>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>
          AIが自動検出したお客様の反論パターンと対応方法です。
        </p>
      </div>

      {patterns.length === 0 ? (
        <div
          style={{
            padding: "32px 20px",
            borderRadius: 14,
            border: "1px solid #1f2937",
            background: "rgba(15,23,42,0.5)",
            color: "#6b7280",
            textAlign: "center",
            fontSize: 14,
          }}
        >
          反論パターンはまだ検出されていません
        </div>
      ) : (
        patterns.map((p) => (
          <div key={p.id} style={CARD}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              <div style={{ flex: 1 }}>
                {/* お客様の反論 */}
                <div style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb", marginBottom: 6 }}>
                  {p.trigger_phrase}
                </div>
                {/* AIの対応方法 */}
                <div
                  style={{
                    fontSize: 13,
                    color: "#9ca3af",
                    marginBottom: 10,
                    lineHeight: 1.5,
                  }}
                >
                  → {p.response_strategy}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {/* 使用原則 */}
                  <span
                    style={{
                      padding: "3px 10px",
                      borderRadius: 999,
                      background: "rgba(139,92,246,0.15)",
                      color: "#c4b5fd",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    使用原則: {p.principle}
                  </span>
                  {/* 成功率 */}
                  <span
                    style={{
                      padding: "3px 10px",
                      borderRadius: 999,
                      background:
                        p.success_rate >= 70
                          ? "rgba(34,197,94,0.12)"
                          : "rgba(234,179,8,0.12)",
                      color: p.success_rate >= 70 ? "#4ade80" : "#fbbf24",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    成功率: {p.success_rate}%（{p.total_count}件中）
                  </span>
                </div>
              </div>

              {/* 削除ボタン */}
              <button
                style={BTN_DANGER}
                onClick={() => handleDelete(p.id)}
                title="削除"
              >
                🗑
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
