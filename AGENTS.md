## Project IDs & Fields
- Project ID: [後で取得] (e.g., PROJECT_V2:1)
- Status Field ID: [STATUS_FIELD_ID]
- Phase Field ID: [PHASE_FIELD_ID] (Custom: Phase 0-10)

## gh CLI Templates
# Issue作成 + Project追加
gh issue create --repo your-org/commerce-faq-tasks --title "Phase 5: Widget埋め込み" --body "DoD: 任意ページ2タグ導入で動作"

# ステータス変更 (Todo → In Progress)
gh project item-edit --project-id [ID] --field-id [STATUS_ID] --single-select-option-id [TODO_OPTION_ID]
