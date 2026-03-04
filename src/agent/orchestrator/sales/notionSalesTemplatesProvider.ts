// src/agent/orchestrator/sales/notionSalesTemplatesProvider.ts
// Phase13: Notion TuningTemplates → SalesTemplateProvider bridge

import type { NotionTuningTemplate } from "../../../integrations/notion/notionSchemas";
import type {
  SalesTemplate,
  SalesTemplateProvider,
  SalesPhase,
} from "./salesRules";
import { setSalesTemplateProvider } from "./salesRules";

/**
 * Transform NotionTuningTemplate → SalesTemplate
 */
function mapToSalesTemplate(t: NotionTuningTemplate): SalesTemplate {
  return {
    id: t.notionPageId,
    phase: t.phase as SalesTemplate["phase"],
    intent: t.intent,
    personaTags: t.persona,
    template: t.template,
  };
}

/**
 * Build provider from list of templates.
 * - Matching priority:
 *   1. phase must match
 *   2. if intent specified by caller, match intent
 *   3. if persona specified, prefer template sharing at least 1 tag
 */
export function createNotionSalesTemplateProvider(
  templates: NotionTuningTemplate[]
): SalesTemplateProvider {
  const mapped = templates.map(mapToSalesTemplate);

  return ({ phase, intent, personaTags }) => {
    const normalizedPhase = (phase as SalesPhase).toLowerCase();
    const phaseMatches = mapped.filter((t) => {
      const tp = (t.phase as string | undefined) ?? "";
      return tp.toLowerCase() === normalizedPhase;
    });
    if (phaseMatches.length === 0) return null;

    let candidates = phaseMatches;

    // Intent match
    if (intent) {
      const intentMatches = candidates.filter((t) => t.intent === intent);
      if (intentMatches.length > 0) candidates = intentMatches;
    }

    // Persona match (at least 1 overlapping tag)
    if (personaTags && personaTags.length > 0) {
      const personaMatches = candidates.filter((t) => {
        if (!t.personaTags || t.personaTags.length === 0) return false;
        return t.personaTags.some((tag) => personaTags.includes(tag));
      });
      if (personaMatches.length > 0) candidates = personaMatches;
    }

    // Return first candidate if exists
    return candidates[0] ?? null;
  };
}

/**
 * Register provider during runtime.
 * - Call this from app bootstrap after loading templates from repository.
 */
export function registerNotionSalesTemplateProvider(
  templates: NotionTuningTemplate[]
) {
  const provider = createNotionSalesTemplateProvider(templates);
  setSalesTemplateProvider(provider);
}
