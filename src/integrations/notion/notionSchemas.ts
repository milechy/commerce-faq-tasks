// src/integrations/notion/notionSchemas.ts
import type {
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";

// FAQ
export interface NotionFaq {
  notionPageId: string;
  tenantId: string; // 今は固定 'english-demo' などでもOK
  question: string;
  answer: string;
  tags: string[];
  intent?: string;
  locale?: string;
  active: boolean;
}

/**
 * Notion Page → NotionFaq への変換
 *
 * Notion DB 側のプロパティ名（Question / Answer / Tags / Intent / Locale / Active）
 * に依存する処理はここに閉じ込める。
 */
export function mapFaqRow(
  page: PageObjectResponse,
  tenantId: string
): NotionFaq {
  const props = page.properties;

  return {
    notionPageId: page.id,
    tenantId,
    question: getTitleText(props["Question"]),
    answer: getRichText(props["Answer"]),
    tags: getMultiSelectNames(props["Tags"]),
    intent: getSelectName(props["Intent"]),
    locale: getSelectName(props["Locale"]),
    active: getCheckbox(props["Active"]),
  };
}

// Products
export interface NotionProduct {
  notionPageId: string;
  tenantId: string;

  name: string;
  code?: string;

  level?: string;
  category?: string;
  price?: number;

  usp?: string;
  targetPersona: string[];
  features?: string;

  compareTags: string[];
  active: boolean;
}

export function mapProductRow(
  page: PageObjectResponse,
  tenantId: string
): NotionProduct {
  const props = page.properties;

  return {
    notionPageId: page.id,
    tenantId,

    name: getTitleText(props["Name"]),
    code: getRichText(props["Code"]),

    level: getSelectName(props["Level"]),
    category: getSelectName(props["Category"]),
    price: getNumber(props["Price"]),

    usp: getRichText(props["USP"]),
    targetPersona: getMultiSelectNames(props["Target Persona"]),
    features: getRichText(props["Features"]),

    compareTags: getMultiSelectNames(props["Compare Tags"]),
    active: getCheckbox(props["Active"]),
  };
}

// LP Points
export interface NotionLpPoint {
  notionPageId: string;
  tenantId: string;

  title: string;
  section?: string;
  point: string;
  tags: string[];
  active: boolean;
}

export function mapLpPointRow(
  page: PageObjectResponse,
  tenantId: string
): NotionLpPoint {
  const props = page.properties;

  return {
    notionPageId: page.id,
    tenantId,

    title: getTitleText(props["Title"]),
    section: getSelectName(props["Section"]),
    point: getRichText(props["Point"]),
    tags: getMultiSelectNames(props["Tags"]),
    active: getCheckbox(props["Active"]),
  };
}

// TuningTemplates
export interface NotionTuningTemplate {
  notionPageId: string;
  tenantId: string;

  name: string;
  phase: string; // Clarify / Propose / Recommend / Close
  intent?: string; // level_diagnosis / goal_setting など
  persona: string[];
  template: string;
  active: boolean;
}

export function mapTuningTemplateRow(
  page: PageObjectResponse,
  tenantId: string
): NotionTuningTemplate {
  const props = page.properties;

  return {
    notionPageId: page.id,
    tenantId,

    name: getTitleText(props["Name"]),
    phase: getSelectName(props["Phase"]) ?? "", // Phase は必須想定
    intent: getSelectName(props["Intent"]),
    persona: getMultiSelectNames(props["Persona"]),
    template: getRichText(props["Template"]),
    active: getCheckbox(props["Active"]),
  };
}

// --- 以下はプロパティタイプ別のヘルパー ---

function getTitleText(property: any): string {
  if (!property || property.type !== "title") return "";
  return (property.title as RichTextItemResponse[])
    .map((t) => t.plain_text ?? "")
    .join("");
}

function getRichText(property: any): string {
  if (!property || property.type !== "rich_text") return "";
  return (property.rich_text as RichTextItemResponse[])
    .map((t) => t.plain_text ?? "")
    .join("");
}

function getMultiSelectNames(property: any): string[] {
  if (!property || property.type !== "multi_select") return [];
  return property.multi_select.map((opt: { name: string }) => opt.name);
}

function getSelectName(property: any): string | undefined {
  if (!property) return undefined;
  if (property.type === "select") {
    return property.select?.name ?? undefined;
  }
  // select じゃなくて rich_text などで持っているケースにも一応対応
  if (property.type === "rich_text") {
    return getRichText(property) || undefined;
  }
  return undefined;
}

function getNumber(property: any): number | undefined {
  if (!property || property.type !== "number") return undefined;
  return typeof property.number === "number" ? property.number : undefined;
}

function getCheckbox(property: any): boolean {
  if (!property || property.type !== "checkbox") return false;
  return Boolean(property.checkbox);
}
