

# Intent Detection Rules (Phase14)

SalesFlow now supports external YAML rules via:
`src/agent/sales/salesIntentRules.yaml`

## Rule Syntax
```yaml
- intent: propose.trial_lesson_offer
  keywords:
    - "体験"
    - "試してみたい"
    - "trial lesson"
  weight: 1.0
```

Rules are matched with:
- keyword containment (case-insensitive)
- score ranking
- fallback to default stage intent per SalesFlow

## Current Rule Categories
- **price_sensitive**
- **existing_user**
- **business**
- **beginner**
- etc.

Templates then map: `intent × personaTags → templateId`.