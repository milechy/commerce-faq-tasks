# CLI Prompt Template: ドキュメント更新 (Docs)

<!-- サンプル元 Asana GID: Phase70-B (1214919520878307), Phase70-J (1214921248316216) -->

---

```
dispatch --model sonnet

## 推奨モデル: Sonnet 4.6

<!--
モデル選択指針:
- Sonnet 4.6: docs 作成・更新は常に Sonnet 4.6
- Opus 4.7: 不要（docs-only タスクで重量モデルを使わない）
Gate 2.5 スキップ可: docs-only / typo 修正 / CSS-only は Codex review 不要
-->

## 前提(重要)
このプロンプトを書いた Claude.ai 側は以下を **実機 read していない**:
- {{TARGET_DOCS_FILE}} の現在の内容
- 関連する既存ドキュメントの構成

→ 下記「作業」のステップ 1 で対象ファイルを read してから書く。推測ベースで上書きしない。

## タスク
{{PHASE_NAME}}: {{SHORT_DESCRIPTION}}

Asana GID: {{ASANA_GID}} (due {{DUE_DATE}})
親: {{PARENT_PHASE}} ({{PARENT_GID}})

## 作業
1. **実機 read(必須、最初に実行)**:
   - `Asana:get_task` で {{ASANA_GID}} を読み、要件確認
   - 対象ファイル {{TARGET_DOCS_FILE}} を read
   - 関連ドキュメント ({{RELATED_DOCS}}) を anatomy.md 記述で確認
   - {{ADDITIONAL_READ_TARGETS}}

2. **ドキュメント更新**:
   - {{DOCS_CHANGE_1}}
   - {{DOCS_CHANGE_2}}
   - 既存リンク・参照が壊れていないか確認

3. **Gate → push → PR**:
   - Gate 1: `pnpm verify` (typecheck + lint + test 全パス)
   - Gate 2: `bash SCRIPTS/security-scan.sh` (High/Critical = 0) — 省略可(docs-only)
   - ~~Gate 2.5~~: docs-only のため Codex review スキップ
   - `git checkout -b docs/{{ASANA_GID}}-{{SHORT_SLUG}}`
   - `git push -u origin HEAD`
   - `gh pr create` (PR description に Asana GID 明記)
   - `bash SCRIPTS/notify-slack.sh "✅ PR #N pushed: docs {{SHORT_DESCRIPTION}}, ready for review" --color success`

## ガードレール
- コード変更禁止（docs ファイルのみ編集）
- 既存リンクを壊さない
- 範囲外: {{OUT_OF_SCOPE_ITEMS}}
- 24h 自走中: VPS 接続 / main merge 禁止

## 完了基準
- {{TARGET_DOCS_FILE}} が更新されている
- {{ACCEPTANCE_CRITERION}}
- Gate 1 グリーン (docs-only = typecheck/lint/test のみ)
- PR description に Asana GID 明記
```
