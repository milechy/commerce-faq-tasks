// SCRIPTS/validateTuningTemplates.ts
// Notion の TuningTemplates DB を読み込んで、
// Phase / Persona / Intent / Template などの基本的な整合性をチェックするスクリプト。
//
// 使い方:
//   npx ts-node SCRIPTS/validateTuningTemplates.ts
//
// 終了コード:
//   - 全て OK の場合: 0
//   - エラーがある場合: 1
//
// 前提:
//   - .env に NOTION_API_KEY, NOTION_DB_TUNING_TEMPLATES_ID が設定されていること。

import "dotenv/config";
import type { NotionTuningTemplate } from "../src/integrations/notion/notionSchemas";
import { NotionSyncService } from "../src/integrations/notion/notionSyncService";

const VALID_PHASES = ["Clarify", "Propose", "Recommend", "Close"] as const;

const VALID_PERSONA_TAGS = [
  "beginner",
  "business",
  "busy",
  "existing_user",
  "intermediate",
  "price_sensitive",
  "general",
] as const;

type ValidPhase = (typeof VALID_PHASES)[number];
type ValidPersonaTag = (typeof VALID_PERSONA_TAGS)[number];

type IssueLevel = "error" | "warning";

type ValidationIssue = {
  level: IssueLevel;
  code: string;
  pageId: string;
  name: string;
  message: string;
};

function isValidPhase(phase: string | null | undefined): phase is ValidPhase {
  if (!phase) return false;
  return (VALID_PHASES as readonly string[]).includes(phase);
}

function isValidPersonaTag(tag: string): tag is ValidPersonaTag {
  return (VALID_PERSONA_TAGS as readonly string[]).includes(tag);
}

async function fetchTemplates(): Promise<NotionTuningTemplate[]> {
  const notionDbId = process.env.NOTION_DB_TUNING_TEMPLATES_ID;
  if (!notionDbId) {
    throw new Error("NOTION_DB_TUNING_TEMPLATES_ID is not set in environment");
  }

  const syncService = new NotionSyncService();
  const templates = await syncService.syncTuningTemplates(notionDbId);
  return templates;
}

function validateTemplate(tpl: NotionTuningTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pageId = tpl.notionPageId;
  const name = tpl.name ?? "(no name)";

  // 1) Name 必須
  if (!tpl.name || tpl.name.trim().length === 0) {
    issues.push({
      level: "error",
      code: "NAME_EMPTY",
      pageId,
      name,
      message: "Name (title) is empty.",
    });
  }

  // 2) Phase のチェック
  if (!tpl.phase) {
    issues.push({
      level: "error",
      code: "PHASE_MISSING",
      pageId,
      name,
      message: "Phase is missing.",
    });
  } else if (!isValidPhase(tpl.phase)) {
    issues.push({
      level: "error",
      code: "PHASE_INVALID",
      pageId,
      name,
      message: `Phase "${
        tpl.phase
      }" is invalid. Expected one of: ${VALID_PHASES.join(", ")}.`,
    });
  }

  // 3) Template 本文のチェック
  if (!tpl.template || tpl.template.trim().length === 0) {
    issues.push({
      level: "error",
      code: "TEMPLATE_EMPTY",
      pageId,
      name,
      message: "Template body is empty.",
    });
  }

  // 4) PersonaTags のチェック
  const personas = tpl.persona ?? [];
  if (!personas || personas.length === 0) {
    issues.push({
      level: "warning",
      code: "PERSONA_NONE",
      pageId,
      name,
      message:
        "No personaTags set. Consider setting one or more of: " +
        VALID_PERSONA_TAGS.join(", ") +
        ".",
    });
  } else {
    for (const tag of personas) {
      if (!isValidPersonaTag(tag)) {
        issues.push({
          level: "warning",
          code: "PERSONA_UNKNOWN",
          pageId,
          name,
          message: `Unknown personaTag "${tag}". Expected one of: ${VALID_PERSONA_TAGS.join(
            ", "
          )}.`,
        });
      }
    }
  }

  // 5) Intent のチェック（必須にはしないが、なければ警告）
  if (!tpl.intent || tpl.intent.trim().length === 0) {
    issues.push({
      level: "warning",
      code: "INTENT_MISSING",
      pageId,
      name,
      message:
        "Intent is missing. You can auto-fill it with SCRIPTS/autoFillIntentSlugs.ts.",
    });
  }

  // 6) Active の型チェック（任意）
  if (typeof tpl.active !== "boolean") {
    issues.push({
      level: "warning",
      code: "ACTIVE_NOT_BOOLEAN",
      pageId,
      name,
      message:
        "Active flag is not a boolean. (This may indicate schema drift.)",
    });
  }

  return issues;
}

async function main() {
  try {
    const templates = await fetchTemplates();

    // eslint-disable-next-line no-console
    console.log(
      `[validateTuningTemplates] validating ${templates.length} templates from Notion...`
    );

    const allIssues: ValidationIssue[] = [];

    for (const tpl of templates) {
      const issues = validateTemplate(tpl);
      allIssues.push(...issues);
    }

    if (allIssues.length === 0) {
      // eslint-disable-next-line no-console
      console.log("[validateTuningTemplates] all templates look good ✅");
      process.exit(0);
    }

    const errors = allIssues.filter((i) => i.level === "error");
    const warnings = allIssues.filter((i) => i.level === "warning");

    // eslint-disable-next-line no-console
    console.log(
      `[validateTuningTemplates] found ${errors.length} errors, ${warnings.length} warnings.`
    );

    const sorted = [...allIssues].sort((a, b) => {
      if (a.level !== b.level) {
        return a.level === "error" ? -1 : 1;
      }
      if (a.code !== b.code) return a.code.localeCompare(b.code);
      return a.name.localeCompare(b.name);
    });

    for (const issue of sorted) {
      const prefix = issue.level === "error" ? "[ERROR]" : "[WARN ]";
      // eslint-disable-next-line no-console
      console.log(
        `${prefix} (${issue.code}) pageId=${issue.pageId} name="${issue.name}" - ${issue.message}`
      );
    }

    process.exit(errors.length > 0 ? 1 : 0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[validateTuningTemplates] failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
