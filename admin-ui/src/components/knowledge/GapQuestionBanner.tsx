export default function GapQuestionBanner({ question }: { question: string }) {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderRadius: 12,
        border: "1px solid rgba(234,179,8,0.4)",
        background: "rgba(120,53,15,0.25)",
        marginBottom: 4,
      }}
    >
      <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: "#fbbf24" }}>
        ❓ ユーザーの質問
      </p>
      <p style={{ margin: "0 0 6px", fontSize: 15, color: "#f9fafb", fontWeight: 600, lineHeight: 1.5 }}>
        「{question}」
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
        この質問に回答できる情報をナレッジに追加してください。登録後、未回答の質問が自動的に解決済みになります。
      </p>
    </div>
  );
}
