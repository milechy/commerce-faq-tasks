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

---

## カスタムルール: DB 接続文字列パスワード (2026-08-30 追加)

> 追加: 2026-08-30 / Phase6 セキュリティ監査
> ルール ID: `db-connection-string-password`

### 背景

本番 Postgres の実パスワード (20桁) が

```
postgresql://postgres:<20桁実PW>@127.0.0.1:5432/commerce_faq
```

の形で複数ドキュメントに書かれ、**git 履歴に残存**していた。標準ルールも `SCRIPTS/security-scan.sh`
の grep も接続文字列内パスワードを拾わず、漏洩が CI をすり抜けていた (監査で発覚)。

### ルールの内容

`.gitleaks.toml` の `[[rules]] id = "db-connection-string-password"`:

- 対象プロトコル: `postgres(ql)` / `mysql` / `mongodb(+srv)` / `redis(s)` / `amqp(s)`
- `proto://user:PASSWORD@host` の PASSWORD を `secretGroup` として抽出 (5文字以上)
- `entropy = 3.2` で低エントロピーのダミー (`pass`, `postgres`, `CHANGE_ME`, `XXXXX` 等) を自動除外
- rule 内 allowlist で `<...>` / `${...}` / `your_password` 等、高エントロピーでも
  プレースホルダと分かるものを明示除外

**設計上の要点**: 実漏洩はホストが `127.0.0.1` (VPS 上で localhost バインドの Postgres) だった。
このため「localhost/127.0.0.1 を一律 allowlist」すると**実漏洩を見逃す**。除外はホストではなく
**パスワードのプレースホルダ性 + エントロピー**で判定している。

### 検証 (2026-08-30)

- working tree (HEAD, `--no-git`): **0 検知** — 既存の正当なプレースホルダで赤くならない
- 一時テスト: 本物形式 6 種 (postgres@10.0.0.5, 同@127.0.0.1, mysql, mongodb+srv, rediss, amqps) を
  全て検知、プレースホルダ 10 種を全て非検知
- `SCRIPTS/security-scan.sh` [3] にも同種 grep を追加 (ホストでなくパスワードで除外)

### 標準ルール (useDefault) を有効化 (2026-08-30 / Phase6)

> 従前このセクションは「標準ルールを有効化しない理由」だった。#1100 は DB 接続文字列ルール
> 1 件のみを追加し `useDefault` は入れなかったため、**AWS キー / GitHub PAT / Slack トークン等の
> 標準シークレット検知が実質 no-op** のままだった。本対応 (`chore/gitleaks-enable-standard-rules`)
> で `[extend] useDefault = true` を追加し、標準ルールを有効化した上で全履歴の既存検知を
> トリアージした。

**標準ルールが実際に効くことの実証**: 本物形式の AWS access key / GitHub PAT / Slack bot token を
リポジトリ外の一時ファイルに書いて scan → `aws-access-token` / `github-pat` / `slack-bot-token` の
3 ルールで検知されることを確認済み (一時ファイルは削除、コミットには含めない)。

#### 全履歴トリアージ内訳 (計 29 件)

| 分類 | 件数 | ルール | 対応 | 生きた資格情報か |
|---|---|---|---|---|
| 難読化 min.js の文字列断片 | 12 | `generic-api-key` | `[allowlist]` path `public/widget.min.js` | 否 (ビルド生成物) |
| 公開 LP/デモ埋め込みキー (`rjc_`) | 7 | `generic-api-key` | `[allowlist]` path `public/lp/`, `public/carnation-demo.html` | 否 (クライアント配布の公開キー) |
| テスト fixture (`rjc_`/`r2c_`/`test`) | 5 | `generic-api-key` | `[allowlist]` path (対象4ファイル) | 否 (合成モック値) |
| Supabase anon key (deploy workflow) | 1 | `jwt` | `.gitleaksignore` fingerprint | 否 (RLS 前提の公開 anon key) |
| CF Web Analytics beacon token | 1 | `generic-api-key` | `.gitleaksignore` fingerprint | 否 (公開ビーコン token) |
| Anthropic API org UUID (docs) | 1 | `generic-api-key` | `.gitleaksignore` fingerprint | 否 (識別子・HEAD redact 済) |
| docs の curl Authorization 例 | 2 | `curl-auth-header` | `.gitleaksignore` fingerprint | 否 (プレースホルダ) |
| **合計** | **29** | — | — | **生きた資格情報: 0 件** |

- **本物として要ローテーションの新規資格情報は 0 件**。標準ルール有効化で新たに露出した生きた
  secret は無かった (DB パスワードのみ #1100 で既知・ローテ要として下記トラック済み)。
- path allowlist は「その dir/ファイルに server-side secret が入る余地が無い」類型
  (min.js ビルド生成物 / 公開 LP / 特定テスト fixture) に限定。deploy workflow・ops guide・docs は
  過去に実 DB パスワードが漏れた種類のため path 一括除外せず、fingerprint 単位に留めている。
- 検証: `gitleaks git . --config .gitleaks.toml` (全履歴) = **0**、
  `gitleaks detect --no-git --config .gitleaks.toml` (working tree) = **0**。

---

## `.gitleaksignore` — 履歴に残る既知の実漏洩 (要ローテーション)

`.gitleaksignore` に登録した 11 件の fingerprint は、上記カスタムルールが検知した
**実在した本番 Postgres パスワード**の履歴残存 (旧コミット) である。

- HEAD からは commit `b9840275` で既に除去済み (working tree には存在しない)。
- 履歴書き換え無しには過去コミットからは消えないため、全履歴スキャンが恒久的に赤くなるのを
  避ける目的で fingerprint 単位で抑止している。
- **これは「無害な誤検知」ではなく本物の資格情報である。公開 GitHub 履歴に露出済みのため
  当該 DB パスワードの*ローテーションは必須* (漏洩監査トラックで別途管理)。**
- カスタムルール自体は生きており、*新規*の同種漏洩は引き続き検知・ブロックする。

---

## 関連ドキュメント

- `docs/SECURITY_SCAN_POLICY.md` — Security scan 全体ポリシー
- `docs/SECURITY_SCAN_ALLOWLIST.md` — pnpm audit の CVE allowlist
- `.gitleaks.toml` — 実際の allowlist 設定
- `.gitleaksignore` — 既知の実漏洩 fingerprint 抑止リスト (要ローテーション)
