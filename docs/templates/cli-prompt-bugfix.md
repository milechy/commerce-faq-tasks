# CLI Prompt Template: バグ修正 (Bugfix)

<!-- サンプル元 Asana GID: Phase70-A (1214919660483265) — deploy_guard.py P1修正 (comment 1214921247806605) -->

---

```
dispatch --model {{MODEL}}

## 推奨モデル: {{MODEL}}

<!--
モデル選択指針:
- Sonnet 4.6: 既知の単純バグ修正、型エラー、lint 修正
- Opus 4.7:   根本原因が不明瞭、セキュリティ関連バグ、複数ファイル連鎖修正
-->

## 前提(重要)
このプロンプトを書いた Claude.ai 側は以下を **実機 read していない**:
- .wolf/buglog.json の過去ログ
- 実際のエラーメッセージ / スタックトレース

→ 下記「作業」のステップ 1 で buglog.json を必ず確認し、既知修正がないか調べる。

## タスク
{{PHASE_NAME}}: {{BUG_SUMMARY}}

Asana GID: {{ASANA_GID}} (due {{DUE_DATE}})
親: {{PARENT_PHASE}} ({{PARENT_GID}})

## 症状・再現手順
- 発生条件: {{TRIGGER_CONDITION}}
- エラーメッセージ: {{ERROR_MESSAGE}}
- 期待動作: {{EXPECTED_BEHAVIOR}}

## 作業
1. **実機 read(必須、最初に実行)**:
   - `.wolf/buglog.json` — 同一エラーの既知修正を確認
   - `.wolf/cerebrum.md` Do-Not-Repeat セクション確認
   - `Asana:get_task` で {{ASANA_GID}} を読み、要件確認
   - `git blame` + `git log --oneline -10 -- {{AFFECTED_FILE}}` で発生コミット特定
   - {{ADDITIONAL_READ_TARGETS}}

2. **原因特定**:
   - {{ROOT_CAUSE_INVESTIGATION}}

3. **修正**:
   - {{FIX_STEP_1}}
   - テストを追加または更新して再発防止

4. **Gate → push → PR**:
   - Gate 1: `pnpm verify` (typecheck + lint + test 全パス)
   - Gate 1.5: `@cleanup` (dead exports / any 型 / as any 除去)
   - Gate 2: `bash SCRIPTS/security-scan.sh` (High/Critical = 0)
   - Gate 2.5: `/codex:review --base main --background` (git push 前)
   - Gate 3: `pnpm build && cd admin-ui && pnpm build`
   - `git checkout -b fix/{{ASANA_GID}}-{{SHORT_SLUG}}`
   - `git push -u origin HEAD`
   - `gh pr create` (PR description に Asana GID + 根本原因 明記)
   - `bash SCRIPTS/notify-slack.sh "✅ PR #N pushed: fix {{BUG_SUMMARY}}, ready for Gate 2.5" --color success`

5. **.wolf/buglog.json に記録**:
   - error_message / root_cause / fix / tags を必ず追記

## ガードレール
- buglog.json 未確認での修正着手禁止
- テストなし修正禁止（再発防止のため必ず追加）
- 範囲外: {{OUT_OF_SCOPE_ITEMS}}
- 3回ルール適用
- 24h 自走中: VPS 接続 / main merge 禁止

## 完了基準
- バグが再現しなくなっている
- 再発防止テスト追加済み
- `.wolf/buglog.json` に修正記録済み
- Gate 1/1.5/2.5 グリーン
- PR description に Asana GID + 根本原因 明記
```
