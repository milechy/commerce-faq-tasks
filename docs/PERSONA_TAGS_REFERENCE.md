# Persona Tags Reference (Phase14)

Persona tags represent user segments that control which Notion template variant is used.

## 1. Supported Persona Tags

- **beginner** — 初心者向けの優しい説明を提供
- **business** — ビジネス用途で英語が必要なユーザー
- **busy** — 時間がない/効率的に学びたいユーザー
- **price_sensitive** — 料金に不安・価格感度が高いユーザー
- **existing_user** — すでにサービス利用中のユーザー
- **intermediate** — 中級者向けの深い説明が必要
- **general** — 汎用テンプレ向け

## 2. How Persona Tags Affect Template Selection

TuningTemplates DB maps:

```
Phase × Intent × PersonaTag → TemplateId
```

Missing templates fall back to:

- same intent, persona = "general"
- builder fallback

## 3. How Developers Can Use Persona Tags

When calling `/dialog/turn` API:

```json
{
  "message": "...",
  "sessionId": "abc",
  "options": {
    "personaTags": ["business"]
  }
}
```

## 4. Authoring Templates in Notion

PersonaTag must match one of the official tags.
Editors should write independent content for:

- beginner
- business
- busy
  etc.

## 5. Future Expansion

- persona-based scoring
- persona inference via intent detection
- dynamic persona switching based on conversation
