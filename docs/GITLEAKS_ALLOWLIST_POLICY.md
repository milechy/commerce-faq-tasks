# Gitleaks Allowlist Policy

> 作成: 2026-05-29 (Asana GID 1215236169618163)
> 設定ファイル: `.gitleaks.toml` (リポジトリルート)
> 関連: `docs/SECURITY_SCAN_POLICY.md`

## 概要

[gitleaks](https://github.com/gitleaks/gitleaks) は secrets/credentials の漏洩を検出する静的解析ツール。
本プロジェクトでは CI (`security-scan.yml`) ではなく **`gitleaks protect --staged`** (コミット前確認) で利用する。

`.gitleaks.toml` は既知の false positive を allowlist に登録し、CI ブロックを防ぎつつ
実在の secrets 検出精度を維持する。

---

## 調査結果サマリ (2026-05-29)

`gitleaks detect --source . --no-git` を実行した結果、**24件**の findings が確認された。

| カテゴリ | 件数 | ルール | 対応 |
|---|---|---|---|
| Asana Project/Task GID | 9 | `asana-client-id` | `.gitleaks.toml` allowlist (regex) |
| Demo widget API key | 8 | `generic-api-key` | `.gitleaks.toml` allowlist (path) |
| Test fixture strings | 4 | `generic-api-key` | `.gitleaks.toml` allowlist (path) |
| **Org UUID in docs** | **1** | `generic-api-key` | **docs から削除 (redact)** |
| 合計 | **22** | — | allowlist 対応 |
| 合計 | **2** | — | 実在穴 → redact 対応 |

> ⚠️ **実在穴**: `docs/MANAGED_AGENTS_APPLICATION.md` に Anthropic API の org UUID が生のまま記載されていた。
> このファイルは redact 済み。

---

## Allowlist 詳細

### 1. Asana Project/Task GID (`asana-client-id` ルール)

**対象**: docs/, PHASE_ROADMAP.md, .claude/skills/, SCRIPTS/ 内の 16 桁数値  
**例**: `1213607637045514`, `1215190233020663`  
**なぜ false positive か**: Asana GID は公開参照用の連番 ID であり OAuth credential ではない。
gitleaks の built-in `asana-client-id` ルールがパターン重複で誤検知する。  
**Entropy 確認**: 数値のみで ~3.3 bits/char — credential の閾値 (3.7+) を下回る。  
**`.gitleaks.toml` 対応**: `regexes` で secret 値が `^121[0-9]{13}$` にマッチするものを除外。

### 2. Demo widget API key (`generic-api-key` ルール)

**対象**: `public/carnation-demo/*.html`  
**値**: `rjc_6c2d...` (carnation デモテナント API key)  
**なぜ allowlist か**: ウィジェット埋め込みデモページの `data-api-key` 属性に意図的に設置された
デモテナント用キー。carnation テナントはサンドボックス環境専用であり、本番テナントには影響しない。
ウィジェット埋め込みサンプルとして公開が必要。  
**`.gitleaks.toml` 対応**: path `public/carnation-demo/` をまるごと allowlist。

### 3. Test fixture strings (`generic-api-key` ルール)

**対象**: `tests/phase48/apiKeyAuth.test.ts`, `tests/widget/trackConversion.test.ts`  
**値**: `my-secret-api-key-12345`, `test-raw-api-key-abc123`, `sk-1234567890abcdef...`, `test-key-abc123`  
**なぜ allowlist か**: テストコードの fixtures であり実在する credential と一切対応しない。
ファイル名・コンテキストから明白に test-only。  
**`.gitleaks.toml` 対応**: path で対象ファイルを allowlist。

---

## 実在穴と是正

### Org UUID in docs (是正済み)

**ファイル**: `docs/MANAGED_AGENTS_APPLICATION.md`  
**内容**: `API Organization UUID: 1f2b5f79-...` (Anthropic API の org 識別子)  
**問題**: org UUID は認証に直接使えないが、テナント識別子として機密性がある。
git 履歴に残ると将来の scans で継続的にブロックされる。  
**是正**: `[REDACTED]` に置換済み (2026-05-29)。

> ⚠️ **ルール**: docs に org UUID・account ID・tenant identifier を生で書かない。
> 必要なら `[REDACTED]` プレースホルダを使い、実際の値は `.env` / Vault 等でのみ管理する。

---

## Allowlist 追加ルール

1. **追加禁止の原則**: 新規の secrets 検出は allowlist に追加せず、実際の secrets を削除・ローテートして対応する。
2. **False positive のみ追加可**: 以下が全て成立する場合のみ追加可能:
   - credentials として機能しないことを確認した
   - entropy 値が credential 閾値 (3.7 bits/char) を下回る、または対象がテストコード/デモファイルである
   - 追加の理由と根拠をこのドキュメントの「Allowlist 詳細」セクションに記載した
3. **PR レビュー**: allowlist 変更は docs PR として Team Lead がレビューする。

---

## Gitleaks 運用手順

### コミット前確認 (推奨)

```bash
gitleaks protect --staged
```

### 全体スキャン (調査用)

```bash
gitleaks detect --source . --no-git
```

### CI との関係

現状の `.github/workflows/security-scan.yml` は `SCRIPTS/security-scan.sh` を実行しており、
gitleaks は直接組み込まれていない。`pnpm audit` / TypeScript check / grep ベースの secrets 検出のみ。

> 将来的な改善: CI に `gitleaks detect --source . --config .gitleaks.toml` を追加することで
> grep ベース検出を gitleaks に統一できる (別タスク)。

---

## 関連ドキュメント

- `docs/SECURITY_SCAN_POLICY.md` — Security scan 全体ポリシー
- `docs/SECURITY_SCAN_ALLOWLIST.md` — pnpm audit の CVE allowlist
- `.gitleaks.toml` — 実際の allowlist 設定
