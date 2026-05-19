# CLI Prompt Template: 事前調査 (Investigation)

<!-- サンプル元 Asana GID: Phase70-A (1214919660483265) — 安全装置設計前調査パターン -->

---

```
dispatch --model sonnet

## 推奨モデル: Sonnet 4.6

<!--
モデル選択指針:
- Sonnet 4.6: コード調査、ログ解析、ファイル探索、方針レポート
- Opus 4.7: 深い設計判断が必要な調査、セキュリティリスク評価
調査タスクにはコード変更 Gate (2, 2.5, 3) は不要。
成果物はレポート (Asana コメント or docs/ ファイル) のみ。
-->

## 前提(重要)
このプロンプトを書いた Claude.ai 側は以下を **実機 read していない**:
- {{LIST_OF_UNREAD_FILES}}
- 現状の実装詳細

→ 調査フェーズ: read・grep・git blame・git log のみ。コード変更禁止。

## タスク
{{PHASE_NAME}}: {{INVESTIGATION_SUBJECT}} — 事前調査

Asana GID: {{ASANA_GID}} (due {{DUE_DATE}})
親: {{PARENT_PHASE}} ({{PARENT_GID}})

## 調査対象
- 目的: {{INVESTIGATION_PURPOSE}}
- 仮説: {{HYPOTHESIS}}
- 調査ファイル / コマンド: {{INVESTIGATION_TARGETS}}

## 作業
1. **実機 read(必須、最初に実行)**:
   - `.wolf/anatomy.md` で関連ファイルを確認
   - `.wolf/buglog.json` で類似問題の既知情報を確認
   - `Asana:get_task` で {{ASANA_GID}} を読み、要件確認

2. **調査**:
   - {{INVESTIGATION_STEP_1}}
   - {{INVESTIGATION_STEP_2}}
   - grep / git log / git blame で実態を確認
   - **コード変更禁止**

3. **レポート**:
   - 調査結果を Asana タスクコメントに投稿
   - 必要なら `docs/investigation/{{ASANA_GID}}-findings.md` にも保存
   - 推奨アクション（実装方針・懸念事項・所要時間見積もり）を明記
   - `bash SCRIPTS/notify-slack.sh "🔍 Investigation complete: {{INVESTIGATION_SUBJECT}}" --color info`

## ガードレール
- **コード変更禁止**（調査のみ）
- 発見した問題を「ついでに修正」しない → 別 Asana タスク化して報告
- 範囲外: {{OUT_OF_SCOPE_ITEMS}}
- 24h 自走中: VPS 接続 / main merge 禁止

## 完了基準
- 調査結果が Asana コメントに投稿されている
- 推奨アクションと所要時間見積もりが明記されている
- Slack #r2c に調査完了通知済み
- **Gate 不要** (コード変更なし)
```
