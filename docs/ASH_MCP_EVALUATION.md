# ASH MCP Server セットアップ評価レポート

作成日: 2026-03-24

## 概要

本ドキュメントは、AWS Automated Security Helper (ASH) の MCP Server 対応状況を調査し、
RAJIUCE プロジェクトへのセキュリティスキャン MCP 統合の推奨アプローチをまとめる。

---

## 1. ASH (aws-samples/automated-security-helper) MCP 対応状況

### 調査結果

**MCP Server 機能: 非対応（2026年3月時点）**

- リポジトリ: `aws-samples/automated-security-helper`
- ASH は Docker コンテナベースのセキュリティスキャナーで、CLI ツールとして設計されている
- MCP (Model Context Protocol) Server としての実装は確認されていない
- GitHub Issues・Releases にも MCP 対応のロードマップは存在しない

### ASH の特徴と制約

| 項目 | 詳細 |
|---|---|
| 動作方式 | Docker コンテナ内でスキャン実行 |
| 対応言語 | Python, JS/TS, Java, Go, Ruby, Terraform, CloudFormation |
| スキャンツール | Bandit, Semgrep, npm audit, Checkov, cfn-nag 等を統合 |
| MCP 対応 | **なし** |
| ローカル実行 | Docker 必須（VPS/CI での利用に適する） |
| RAJIUCE 適合性 | Docker 環境がある場合は有効だが、MCP 統合は不可 |

---

## 2. 代替 MCP サーバー候補

### 2-1. セキュリティスキャン系 MCP サーバー（Docker MCP Catalog）

| ツール | MCP 対応 | 用途 | 備考 |
|---|---|---|---|
| `github/github-mcp-server` | ✅ | GitHub PR・Issue 操作、Dependabot alerts 取得 | npm audit 結果の Issue 化に活用可 |
| `snyk/snyk-mcp` | 調査中 | 依存関係・コード脆弱性スキャン | Snyk CLI ラッパー、有料プランが必要な機能あり |
| `aquasecurity/trivy-mcp` | 非公式 | コンテナ・ファイルシステムスキャン | Trivy の MCP ラッパーは非公式実装のみ確認 |
| `npm-audit-mcp` | 非公式 | npm audit 結果の解析 | npmjs に公開された軽量ラッパー、メンテナンス状況不明 |

### 2-2. SAST (Static Analysis) 系

| ツール | MCP 対応 | 用途 |
|---|---|---|
| `semgrep` | CLI のみ | ルールベースの静的解析（ASH が内部で使用） |
| `sonarqube-mcp` | 非公式プロトタイプ | SonarQube スキャン結果の MCP 取得 |

### 2-3. 現時点で最も実用的な選択肢

**`github/github-mcp-server`** が唯一の公式 MCP サーバーで、以下の用途に活用できる:
- Dependabot security alerts の取得・トリアージ
- セキュリティスキャン結果を GitHub Issue として自動作成
- PR の脆弱性チェック結果のコメント化

---

## 3. 推奨アプローチ

### フェーズ1（現在）: カスタムスクリプト + CI

```
SCRIPTS/security-scan.sh  →  pnpm verify 統合  →  .github/workflows/security-scan.yml
```

- MCP 不使用でも `bash SCRIPTS/security-scan.sh` により同等のスキャンが可能
- pnpm audit + TypeScript strict + secrets leak + SQL injection の4軸カバー
- **コスト: $0**（外部サービス不要）

### フェーズ2（推奨）: GitHub MCP Server 統合

```
claude-code + github-mcp-server  →  Dependabot alerts 取得  →  自動トリアージ
```

インストール手順:
```bash
# ~/.claude/claude_desktop_config.json に追加
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

活用シナリオ:
- `mcp__github__list_dependabot_alerts` で脆弱性一覧取得
- スキャン結果を Claude Code が解析して修正案を提示

### フェーズ3（将来）: Snyk MCP 評価

- Snyk が公式 MCP Server を正式リリースした場合に再評価
- 現時点では Snyk CLI を CI に組み込む方が安定

---

## 4. RAJIUCE プロジェクトへの導入推奨

| 優先度 | アクション | 工数 |
|---|---|---|
| **P0** | 現在の `SCRIPTS/security-scan.sh` を定期実行（月次） | 0h（設定済み） |
| **P0** | `.github/workflows/security-scan.yml` で CI 自動化 | 0h（設定済み） |
| **P1** | `github-mcp-server` を Claude Code に設定し Dependabot alerts を統合 | 0.5h |
| **P2** | Snyk 公式 MCP リリース後に再評価 | 将来検討 |
| **P3** | ASH を Docker 環境で手動実行（VPS での四半期スキャン） | 1h/quarter |

---

## 5. 結論

ASH の MCP Server 対応は現時点で存在しないが、RAJIUCE プロジェクトには以下で十分なカバレッジが得られる:

1. **`SCRIPTS/security-scan.sh`** — ローカル即時スキャン（設定済み）
2. **`.github/workflows/security-scan.yml`** — CI 自動スキャン（設定済み）
3. **`github-mcp-server`** — Dependabot alerts の MCP 統合（次ステップ推奨）

ASH 本体は将来 VPS に Docker 環境が整った際の強化オプションとして検討する。
