# CLI Prompt Template: リファクタ (Refactor)

<!-- サンプル元 Asana GID: Phase70-B (1214919520878307) — CLAUDE.md + auto-memory 整備 -->

---

```
dispatch --model {{MODEL}}

## 推奨モデル: {{MODEL}}

<!--
モデル選択指針:
- Sonnet 4.6: 命名変更、dead code 除去、型付け改善、単一ファイル整理
- Opus 4.7:   モジュール分割、依存関係再設計、複数ファイル横断リファクタ
- Plan Mode (+ Opus 4.7): アーキテクチャ変更を伴うリファクタ（実装前に計画承認が必要）
-->

## 前提(重要)
このプロンプトを書いた Claude.ai 側は以下を **実機 read していない**:
- {{LIST_OF_UNREAD_FILES}}
- 現在の依存関係グラフ / 呼び出し箇所

→ 下記「作業」のステップ 1 で必ず実機 read し、影響範囲を正確に把握してから着手する。
**機能変更 = scope 外。リファクタは振る舞いを変えない。**

## タスク
{{PHASE_NAME}}: {{SHORT_DESCRIPTION}}

Asana GID: {{ASANA_GID}} (due {{DUE_DATE}})
親: {{PARENT_PHASE}} ({{PARENT_GID}})

## 対象ファイル / 対象範囲
- 変更してよい: {{ALLOWED_SCOPE}}
- 変更してはならない: {{FORBIDDEN_SCOPE}} (振る舞い・公開 API・DB スキーマ)

## 作業
1. **実機 read(必須、最初に実行)**:
   - `.wolf/anatomy.md` で対象ファイルの依存関係を確認
   - `.wolf/cerebrum.md` Do-Not-Repeat + Key Learnings 確認
   - `Asana:get_task` で {{ASANA_GID}} を読み、要件確認
   - grep で対象シンボルの呼び出し箇所を全列挙
   - {{ADDITIONAL_READ_TARGETS}}

2. **リファクタ**:
   - {{REFACTOR_STEP_1}}
   - {{REFACTOR_STEP_2}}
   - 変更前後で振る舞いが同一であることをテストで確認

3. **Gate → push → PR**:
   - Gate 1: `pnpm verify` (typecheck + lint + test 全パス)
   - Gate 1.5: `@cleanup` (dead exports / any 型 / as any 除去) — リファクタの主目的と重複する場合は省略可
   - Gate 2: `bash SCRIPTS/security-scan.sh` (High/Critical = 0)
   - Gate 2.5: `/codex:review --base main --background` (git push 前)
   - Gate 3: `pnpm build && cd admin-ui && pnpm build`
   - `git checkout -b refactor/{{ASANA_GID}}-{{SHORT_SLUG}}`
   - `git push -u origin HEAD`
   - `gh pr create` (PR description に Asana GID 明記)
   - `bash SCRIPTS/notify-slack.sh "✅ PR #N pushed: refactor {{SHORT_DESCRIPTION}}, ready for Gate 2.5" --color success`

## ガードレール
- 機能変更禁止（振る舞い同一を維持）
- 「ついでに修正」禁止（発見バグは別 Asana タスク化）
- 範囲外: {{OUT_OF_SCOPE_ITEMS}}
- 3回ルール適用
- 24h 自走中: VPS 接続 / main merge 禁止

## 完了基準
- 振る舞いが変わっていないことをテストで確認済み
- {{ACCEPTANCE_CRITERION}}
- Gate 1/1.5/2.5 グリーン
- PR description に Asana GID 明記
```
