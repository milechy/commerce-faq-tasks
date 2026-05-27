# セキュリティスキャンポリシー

## 目的

RAJIUCE プロジェクトのセキュリティ品質を継続的に維持するため、自動・手動スキャンを組み合わせた多層的なセキュリティチェック体制を運用する。

## スキャン対象

- Node.js 依存パッケージの脆弱性（npm audit）
- TypeScript 型安全性（strict check）
- シークレット・認証情報の漏洩（grep ベース静的解析）
- SQL インジェクションパターン（文字列補間検出）

---

## フェーズ別運用

### フェーズ1: ローカル手動実行

```bash
bash SCRIPTS/security-scan.sh
```

- 実行者: 開発者・デプロイ担当者
- タイミング: デプロイ前に必須

### フェーズ2: GitHub Actions CI 統合

- ファイル: `.github/workflows/security-scan.yml`
- トリガー: main へのプッシュ、PR、週次スケジュール（毎週月曜 9:00 UTC）
- High/Critical 検出時はワークフローを失敗扱いにしてデプロイをブロック

### フェーズ3: precommit hook

- `pnpm typecheck` と secrets leak チェックをコミット前に自動実行
- Husky または lefthook で設定予定

---

## 実行頻度

| タイミング | 方法 | 必須 / 推奨 |
|---|---|---|
| デプロイ前 | `bash SCRIPTS/security-scan.sh` | **必須** |
| main push / PR | GitHub Actions CI | **必須** |
| 週次定期 | GitHub Actions（スケジュール） | 推奨 |
| コミット前 | precommit hook（フェーズ3） | 推奨 |

---

## 検出結果の対応方針

| 深刻度 | 対応期限 | 対応方法 |
|---|---|---|
| Critical / High | **即時対応**（デプロイブロック） | パッケージ更新または回避策を即日適用 |
| Medium | **1週間以内** | 次スプリントで対応 |
| Low | バックログ管理 | 定期レビューで優先度判断 |

---

## 人間によるセキュリティ操作ルール

- **AI（Claude Code）の役割**: スキャン結果の分析、修正コードの生成・提案
- **人間の役割**: 実際のスキャン実行、VPS での修正適用・デプロイ判断
- AI がスキャンを自律的に VPS 上で実行したり、本番環境へ直接修正を適用することは禁止
- スキャン結果に基づく修正コードのレビューと最終承認は必ず人間が行う

---

## ローカル ⇔ CI 判定一致 (2026-05-27, GID 1215114679975245)

- `SCRIPTS/security-scan.sh` の audit 評価は **`pnpm audit --production --audit-level=high`** に統一済み (旧 `|| true` 握り潰しを撤廃)。
- `set -o pipefail` で `{ ... } | tee` 内部の `exit 1` を script 終了コードに伝播。
- CI `.github/workflows/security-scan.yml` の独立 audit ステップと **判定基準・対象パス・閾値が完全一致**。
- ignore 対象 CVE は **`package.json#pnpm.auditConfig.ignoreCves` で集中管理**。根拠と再評価トリガーは `docs/SECURITY_SCAN_ALLOWLIST.md#pnpm-auditconfig-ignorecves` を参照。

> ⚠️ `pnpm verify` (定義: `package.json#scripts.verify`) の末尾には `bash SCRIPTS/security-scan.sh || true` が残っており、Gate 1 単独では audit 失敗を捕らえない。`bash SCRIPTS/security-scan.sh` を別途実行するか、verify から `|| true` を撤廃する follow-up を別 PR で扱う。

## 関連ファイル

- スキャンスクリプト: `SCRIPTS/security-scan.sh`
- CI ワークフロー: `.github/workflows/security-scan.yml`
- デプロイチェックリスト: `docs/DEPLOY_CHECKLIST.md`
- CLAUDE.md セキュリティゲートセクション: `## Security Scan`
- ALLOWLIST 運用: `docs/SECURITY_SCAN_ALLOWLIST.md`
