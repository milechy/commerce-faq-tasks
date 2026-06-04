# CLI Prompt Template: 機能追加 (Feature)

<!-- サンプル元 Asana GID: Phase70-A (1214919660483265), Phase70-D (1214919660548852), Phase70-L (1214921011388648) -->

---

```
dispatch --model {{MODEL}}

## 推奨モデル: {{MODEL}}

<!--
モデル選択指針:
- Sonnet 4.6: 既存パターン踏襲の追加、docs/bash スクリプト/TypeScript 軽量変更
- Opus 4.7:   セキュリティ層変更、Asana API 連携、新アーキテクチャ、複雑ロジック
- Plan Mode (+ Opus 4.7): 影響範囲が広い変更、複数ファイル横断の設計変更
-->

## 前提(重要)
このプロンプトを書いた Claude.ai 側は以下を **実機 read していない**:
- {{LIST_OF_UNREAD_FILES}}
- 関連 Phase の既実装内容

→ 下記「作業」のステップ 1 で必ず実機を read し、推測ベースで実装しない。

## タスク
{{PHASE_NAME}}: {{SHORT_DESCRIPTION}}

Asana GID: {{ASANA_GID}} (due {{DUE_DATE}})
親: {{PARENT_PHASE}} ({{PARENT_GID}})

## 作業
1. **実機 read(必須、最初に実行)**:
   - `.wolf/anatomy.md` で対象ファイルを確認してから読む
   - `.wolf/cerebrum.md` Do-Not-Repeat セクション確認
   - `.wolf/buglog.json` で類似バグ既知解を確認
   - `Asana:get_task` で {{ASANA_GID}} を読み、要件の正確な定義を確認
   - {{ADDITIONAL_READ_TARGETS}}

2. **実装**:
   - {{IMPL_STEP_1}}
   - {{IMPL_STEP_2}}
   - {{IMPL_STEP_3}}

3. **Gate → push → PR**:
   - Gate 1: `pnpm verify` (typecheck + lint + test 全パス)
   - Gate 1.5: `@cleanup` (dead exports / any 型 / as any 除去)
   - Gate 2: `bash SCRIPTS/security-scan.sh` (High/Critical = 0)
   - Gate 2.5: `/codex:review --base main --background` (git push 前)
   - Gate 3: `pnpm build && cd admin-ui && pnpm build`
   - `git checkout -b feature/{{ASANA_GID}}-{{SHORT_SLUG}}`
   - `git push -u origin HEAD`
   - `gh pr create` (PR description に Asana GID 明記)
   - `bash SCRIPTS/notify-slack.sh "✅ PR #N pushed: {{SHORT_DESCRIPTION}}, ready for Gate 2.5" --color success`

## ガードレール
- 推測ベースで書かない、実 read 必須
- 範囲外: {{OUT_OF_SCOPE_ITEMS}}
- 3回ルール適用（同一ファイルを 3回以上編集したら .wolf/buglog.json に記録して立ち止まる）
- 24h 自走中: VPS 接続 / main merge / DB migration / .env 編集 禁止

## 完了基準
- {{ACCEPTANCE_CRITERION_1}}
- {{ACCEPTANCE_CRITERION_2}}
- Gate 1/1.5/2.5 グリーン
- PR description に Asana GID 明記
- Slack #r2c に PR 作成完了通知済み
```
