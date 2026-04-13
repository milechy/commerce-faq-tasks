// admin-ui/src/components/admin/TenantTestTab.tsx
// Phase4-B: テナント詳細ハブ — テストタブ

import { useNavigate } from "react-router-dom";

interface Props {
  tenantId: string;
  tenantName: string;
}

export default function TenantTestTab({ tenantId, tenantName }: Props) {
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 560 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>
        チャットテスト
      </h2>
      <p style={{ margin: "0 0 28px", fontSize: 14, color: "#9ca3af", lineHeight: 1.6 }}>
        このテナント（{tenantName}）のAIアバターと実際に会話して、応答品質や設定の効果を確認できます。
      </p>

      <button
        onClick={() => navigate(`/admin/chat-test?tenant=${tenantId}`)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 10,
          padding: "14px 24px", minHeight: 52, borderRadius: 12,
          border: "1px solid rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.1)",
          color: "#4ade80", fontSize: 16, fontWeight: 700, cursor: "pointer",
          transition: "all 0.15s",
        }}
      >
        <span style={{ fontSize: 20 }}>💬</span>
        チャットテストを開始
      </button>

      <div
        style={{
          marginTop: 24, padding: "14px 18px", borderRadius: 10,
          border: "1px solid #1f2937", background: "rgba(15,23,42,0.5)",
          fontSize: 13, color: "#6b7280", lineHeight: 1.6,
        }}
      >
        <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#9ca3af" }}>テストでできること：</p>
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          <li>チューニングルールが正しく適用されているか確認</li>
          <li>RAGの回答精度を評価</li>
          <li>アバターの応答スタイルをチェック</li>
        </ul>
      </div>
    </div>
  );
}
