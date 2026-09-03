// src/api/admin/analytics/componentSelfcheck.ts
//
// L0-4(Gate 0): hermes-dojo / hermes-vault の selfcheck 結果を置く枠。
// 2026-09-03 時点でこの2部品はリポジトリのどこにも配線されていない
// (grep 0件)。新しい計測基盤は作らない(CLAUDE.md禁止32)ため、実データが
// 無い事実をそのまま「未導入」として返す純関数のみここに用意する。
// 将来どちらかが配線されたら、この関数の中身をそのコンポーネントの
// 実際のヘルスチェック呼び出しに差し替える(枠は変えない)。

export type ComponentSelfcheckStatus = "not_installed" | "ok" | "error";

export interface ComponentSelfcheckResult {
  id: "hermes-dojo" | "hermes-vault";
  status: ComponentSelfcheckStatus;
}

export function getComponentSelfcheckResults(): ComponentSelfcheckResult[] {
  return [
    { id: "hermes-dojo", status: "not_installed" },
    { id: "hermes-vault", status: "not_installed" },
  ];
}
