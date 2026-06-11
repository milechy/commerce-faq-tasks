// admin-ui/src/pages/admin/avatar/StudioBasicSection.tsx
// studio.tsx から抽出 — 1. 基本設定セクション（機能変更なし）

import { useLang } from "../../../i18n/LangContext";
import { SECTION_STYLE, LABEL_STYLE, INPUT_STYLE } from "./types";

export function StudioBasicSection({
  name,
  setName,
  lemonsliceAgentId,
  setLemonsliceAgentId,
}: {
  name: string;
  setName: (v: string) => void;
  lemonsliceAgentId: string;
  setLemonsliceAgentId: (v: string) => void;
}) {
  const { lang } = useLang();

  return (
    <div style={SECTION_STYLE}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
        {lang === "ja" ? "1. 基本設定" : "1. Basic Settings"}
      </h2>
      <div style={{ marginBottom: 14 }}>
        <label style={LABEL_STYLE}>{lang === "ja" ? "アバター名 *" : "Avatar Name *"}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={lang === "ja" ? "例: サポートアシスタント" : "e.g. Support Assistant"}
          style={INPUT_STYLE}
        />
      </div>
      <div>
        <label style={LABEL_STYLE}>Lemonslice Agent ID</label>
        <input type="text" value={lemonsliceAgentId} onChange={(e) => setLemonsliceAgentId(e.target.value)}
          placeholder="agent_xxxxxxxxxx" style={INPUT_STYLE} />
      </div>
    </div>
  );
}
