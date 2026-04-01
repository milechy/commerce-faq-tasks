import { useState } from "react";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface Variant {
  id: string;
  name: string;
  prompt: string;
  ratio: number;
  avg_score?: number;
  conversation_count?: number;
}

// ─── モックデータ ─────────────────────────────────────────────────────────────

const MOCK_VARIANTS: Variant[] = [
  {
    id: "va",
    name: "標準版",
    prompt: "お客様のご要望を丁寧にヒアリングし、最適なソリューションをご提案します。",
    ratio: 70,
    avg_score: 68,
    conversation_count: 145,
  },
  {
    id: "vb",
    name: "積極版",
    prompt: "お客様の課題を素早く把握し、具体的な成果を示しながら積極的に提案を進めます。",
    ratio: 30,
    avg_score: 76,
    conversation_count: 62,
  },
];

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
  marginBottom: 12,
};

const INPUT: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(0,0,0,0.3)",
  color: "#f9fafb",
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
};

const LABEL: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#9ca3af",
  marginBottom: 6,
};

const BTN_GHOST: React.CSSProperties = {
  padding: "8px 14px",
  minHeight: 44,
  minWidth: 64,
  borderRadius: 10,
  border: "1px solid #374151",
  background: "transparent",
  color: "#9ca3af",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: "8px 20px",
  minHeight: 44,
  borderRadius: 10,
  border: "none",
  background: "rgba(34,197,94,0.2)",
  color: "#4ade80",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
};

const BTN_DANGER: React.CSSProperties = {
  padding: "8px 14px",
  minHeight: 44,
  minWidth: 44,
  borderRadius: 8,
  border: "1px solid rgba(239,68,68,0.3)",
  background: "transparent",
  color: "#f87171",
  fontSize: 14,
  cursor: "pointer",
};

// ─── 編集モーダル ─────────────────────────────────────────────────────────────

function VariantModal({
  initial,
  onSave,
  onClose,
}: {
  initial: Variant | null;
  onSave: (v: Omit<Variant, "id" | "avg_score" | "conversation_count">) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [ratio, setRatio] = useState(String(initial?.ratio ?? 50));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 3000,
        padding: "20px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          borderRadius: 16,
          border: "1px solid #374151",
          background: "linear-gradient(145deg, rgba(15,23,42,0.98), rgba(15,23,42,0.95))",
          padding: "24px 20px",
        }}
      >
        <h3 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: "0 0 20px" }}>
          {initial ? "バリエーション編集" : "バリエーション追加"}
        </h3>

        <div style={{ marginBottom: 16 }}>
          <label style={LABEL}>バリエーション名</label>
          <input
            style={INPUT}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 標準版"
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={LABEL}>プロンプト本文</label>
          <textarea
            style={{ ...INPUT, minHeight: 120, resize: "vertical" }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="このバリエーションで使用するプロンプトを入力"
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={LABEL}>配分比率（%）</label>
          <input
            style={INPUT}
            type="number"
            min={1}
            max={100}
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button style={BTN_GHOST} onClick={onClose}>キャンセル</button>
          <button
            style={{ ...BTN_PRIMARY, flex: 1, width: "auto" }}
            onClick={() => {
              if (!name.trim()) return;
              onSave({ name: name.trim(), prompt: prompt.trim(), ratio: Number(ratio) || 50 });
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── A/Bテストタブ ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function ABTestTab({ tenantId: _tenantId }: { tenantId: string }) {
  const [variants, setVariants] = useState<Variant[]>(MOCK_VARIANTS);
  const [editTarget, setEditTarget] = useState<Variant | null | "new">(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const totalRatio = variants.reduce((sum, v) => sum + v.ratio, 0);
  const ratioOk = totalRatio === 100;

  const bestVariant = variants.reduce<Variant | null>((best, v) => {
    if (!best || (v.avg_score ?? 0) > (best.avg_score ?? 0)) return v;
    return best;
  }, null);

  const handleSave = (data: Omit<Variant, "id" | "avg_score" | "conversation_count">) => {
    if (editTarget === "new") {
      const newV: Variant = { ...data, id: `v${Date.now()}` };
      setVariants((prev) => [...prev, newV]);
      showToast("✅ バリエーションを追加しました");
    } else if (editTarget) {
      setVariants((prev) =>
        prev.map((v) => (v.id === editTarget.id ? { ...v, ...data } : v))
      );
      showToast("✅ バリエーションを保存しました");
    }
    setEditTarget(null);
  };

  const handleDelete = (id: string) => {
    setVariants((prev) => prev.filter((v) => v.id !== id));
    showToast("🗑 バリエーションを削除しました");
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

      {/* バリエーション一覧 */}
      <div style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
          A/Bテスト設定
        </h3>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
          バリエーションごとにプロンプトと配分比率を設定できます。
        </p>
      </div>

      {variants.map((v) => (
        <div key={v.id} style={CARD}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb" }}>
                  バリエーション「{v.name}」
                </span>
                <span
                  style={{
                    padding: "2px 10px",
                    borderRadius: 999,
                    background: "rgba(59,130,246,0.15)",
                    color: "#93c5fd",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  比率: {v.ratio}%
                </span>
              </div>
              {v.prompt && (
                <p style={{ fontSize: 13, color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
                  {v.prompt.length > 80 ? v.prompt.slice(0, 80) + "…" : v.prompt}
                </p>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={BTN_GHOST} onClick={() => setEditTarget(v)}>
                編集
              </button>
              <button style={BTN_DANGER} onClick={() => handleDelete(v.id)}>
                削除
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* 比率警告 */}
      {!ratioOk && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            background: "rgba(234,179,8,0.1)",
            border: "1px solid rgba(234,179,8,0.3)",
            color: "#fbbf24",
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          ⚠️ 比率の合計は100%にしてください（現在: {totalRatio}%）
        </div>
      )}

      {/* バリエーション追加 */}
      <button style={BTN_PRIMARY} onClick={() => setEditTarget("new")}>
        + バリエーション追加
      </button>

      {/* テスト結果（直近30日） */}
      {variants.some((v) => v.avg_score !== undefined) && (
        <div style={{ ...CARD, marginTop: 24 }}>
          <h4 style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb", margin: "0 0 16px" }}>
            テスト結果（直近30日）
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {variants.map((v) => (
              <div
                key={v.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid #1f2937",
                }}
              >
                <span style={{ fontSize: 14, color: "#d1d5db", fontWeight: 600 }}>
                  バリエーション「{v.name}」
                </span>
                <div style={{ display: "flex", gap: 16 }}>
                  <span style={{ fontSize: 14, color: "#9ca3af" }}>
                    平均スコア{" "}
                    <span style={{ color: "#f9fafb", fontWeight: 700 }}>
                      {v.avg_score}点
                    </span>
                  </span>
                  <span style={{ fontSize: 14, color: "#9ca3af" }}>
                    会話数:{" "}
                    <span style={{ color: "#f9fafb", fontWeight: 700 }}>
                      {v.conversation_count}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* ベストバリエーション提案 */}
          {bestVariant && variants.length >= 2 && (() => {
            const scores = variants.map((v) => v.avg_score ?? 0);
            const diff = Math.max(...scores) - Math.min(...scores);
            if (diff <= 0) return null;
            return (
              <div
                style={{
                  marginTop: 12,
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: "rgba(34,197,94,0.08)",
                  border: "1px solid rgba(34,197,94,0.2)",
                  color: "#4ade80",
                  fontSize: 14,
                }}
              >
                💡 バリエーション「{bestVariant.name}」が{diff}点高いスコアを記録しています
              </div>
            );
          })()}
        </div>
      )}

      {/* 編集/追加モーダル */}
      {editTarget !== null && (
        <VariantModal
          initial={editTarget === "new" ? null : editTarget}
          onSave={handleSave}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
