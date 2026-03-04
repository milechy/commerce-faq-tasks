# Intent Taxonomy — SalesFlow (English Conversation Domain)

Phase14 / commerce-faq-tasks  
This document defines the intent taxonomy used in the SalesFlow pipeline (Clarify → Propose → Recommend → Close) with the goal of enabling externalized templates (Notion / local .md) and consistent runtime behavior.

---

## 1. Overview

SalesFlow in the English conversation domain consists of four phases:

1. **Clarify** — Understand the learner’s goals, level, constraints.
2. **Propose** — Offer relevant next actions (trial lessons, plan suggestions, upgrades).
3. **Recommend** — Recommend a course or learning plan based on assessments.
4. **Close** — Support the learner to finalize a decision.

Each phase has its own set of intents.  
Each intent corresponds to **one template entry** in the TuningTemplates (Notion or local .md), with optional personaTags.

---

## 2. Clarify Phase Intents

Used to collect essential information before proposing or recommending.

### `level_diagnosis`

- Understand current English proficiency.
- Example questions:
  - “普段どんな場面で英語を使いますか？”
  - “文法やリスニングで苦手な部分はありますか？”

### `goal_setting`

- Identify specific learning goals.
- Example:
  - “いつまでにどのレベルを目指していますか？”
  - “TOEIC / 日常会話 / ビジネス英会話など、目標はありますか？”

### `current_usage`

- Learn about user habits and frequency.
- Example:
  - “普段どれくらい英語を勉強していますか？”

### `time_budget`

- Understand time availability.
- Example:
  - “週にどれくらいレッスン時間を確保できますか？”

---

## 3. Propose Phase Intents

These are used after Clarify when presenting actionable next steps.

### `trial_lesson_offer`

Initial trial lesson suggestion.  
Used for new learners or first-time visitors.

### `propose_monthly_plan_basic`

Recommend a low-commitment plan (1–2 lessons/week).  
Suitable for beginners or busy professionals.

### `propose_monthly_plan_premium`

Recommend a high-frequency or premium plan (3–5 lessons/week).  
Focused on accelerated progress or deadline-driven goals.

### `propose_subscription_upgrade`

For existing users whose activity or goals suggest higher-level plans.

---

## 4. Recommend Phase Intents

(To be implemented in Phase14 Step2)

### `recommend_course_based_on_level`

Suggest a course tailored to the learner’s proficiency.

### `recommend_course_for_goal`

Recommend a course based on specific goals (e.g., business conversation, TOEIC, travel).

### `recommend_addon_module`

Optional addons (grammar, pronunciation coaching, interview prep).

---

## 5. Close Phase Intents

(To be implemented in Phase14 Step3)

### `close_after_trial`

Encourage the learner to continue after experiencing a trial lesson.

### `close_handle_objection_price`

Address concerns about pricing or commitment.

### `close_next_step_confirmation`

Guide toward taking the next step (booking schedule, finalizing plan).

---

## 6. Notion Template Mapping Rules

Each template entry must include:

| Field         | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `phase`       | clarify / propose / recommend / close                      |
| `intent`      | intent slug defined in this doc                            |
| `personaTags` | optional filters: beginner, business-person, student, etc. |
| `template`    | final message shown to the learner                         |

---

## 7. Notes for Template Writers

- Templates should be **goal-oriented**, not purely informative.
- Keep tone **encouraging**, **actionable**, and **personalized**.
- Persona-specific templates may override generic ones, e.g.:
  - `["business"]` → business learners
  - `["beginner"]` → new learners
- Avoid hard-coded prices unless tenant-specific.

---

## 8. Future Extensions

- Add B2B-specific intents.
- Add intents for “learning recovery” (ユーザーがしばらく学習していないときの復帰提案).
- Integrate metrics from SalesLog (Phase14 Step4).

---

Last updated: Phase14 — Intent taxonomy foundation for English conversation domain.

---

## 9. PersonaTags — Official List (Phase14)

PersonaTags are used as filters for selecting the appropriate template in SalesFlow.  
To ensure global consistency and avoid ambiguity across tenants and integrations,  
**all personaTags must use English slug format (lower_snake_case).**

| Tag                | Meaning / Usage                                      |
|--------------------|-------------------------------------------------------|
| `beginner`         | Beginner-level learners                               |
| `intermediate`     | Intermediate learners                                 |
| `advanced`         | Advanced learners                                     |
| `business`         | Learners focused on business English                  |
| `working_professional` | General working adults                           |
| `student`          | High school / university students                     |
| `busy`             | Users with limited available time                     |
| `price_sensitive`  | Users concerned about pricing                         |
| `existing_user`    | Current subscribers / active users                    |
| `expat`            | Overseas residents / expatriates                      |
| `toeic_focus`      | TOEIC-focused learners                                |
| `travel_focus`     | Learners preparing for travel                         |
| `general`          | Generic / unspecific persona                          |

### Notes
- personaTags are optional; templates without personaTags act as fallbacks.
- Multiple personaTags may be combined (e.g., `["beginner", "busy"]`).
- When Notion and code disagree, Notion is treated as the source of truth.
