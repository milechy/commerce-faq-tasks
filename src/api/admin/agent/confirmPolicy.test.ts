// src/api/admin/agent/confirmPolicy.test.ts
//
// 主眼は「登録漏れの検出」。toolDefinitions.ts に新しいツールが増えたのに
// confirmPolicy.ts で分類されていない、という取りこぼしで落ちるようにする。

import { readFileSync } from 'fs';
import { join } from 'path';
import { ADMIN_AGENT_TOOLS } from './toolDefinitions';
import { WRITE_TOOL_RISK_TIERS, NON_WRITE_TOOLS, requiresConfirmation, type RiskTier } from './confirmPolicy';

const ALL_TOOL_NAMES = ADMIN_AGENT_TOOLS.map((t) => t.function.name);

describe('confirmPolicy: リスク階層表の網羅性', () => {
  it('toolDefinitions.ts の全ツールが「書き込み(階層付き)」か「非書き込み」のどちらかに分類されている', () => {
    const classified = new Set([...Object.keys(WRITE_TOOL_RISK_TIERS), ...NON_WRITE_TOOLS]);
    const unclassified = ALL_TOOL_NAMES.filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
  });

  it('分類表に、存在しないツール名が残っていない', () => {
    const known = new Set(ALL_TOOL_NAMES);
    const stale = [...Object.keys(WRITE_TOOL_RISK_TIERS), ...NON_WRITE_TOOLS].filter((name) => !known.has(name));
    expect(stale).toEqual([]);
  });

  it('同じツールが書き込み表と非書き込み表の両方に入っていない', () => {
    const both = NON_WRITE_TOOLS.filter((name) => name in WRITE_TOOL_RISK_TIERS);
    expect(both).toEqual([]);
  });

  it('全ツールが分類表のいずれか一方だけで数え上げられる', () => {
    expect(Object.keys(WRITE_TOOL_RISK_TIERS).length + NON_WRITE_TOOLS.length).toBe(ALL_TOOL_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// actionExecutor.ts のソースを機械的に読み、書き込みを行っている case を検出する。
// 手で写した一覧は必ず腐るため、実装側の変化（読み取り専用ツールが書き込みを
// 始めた等）をここで拾えるようにしておく。
// ---------------------------------------------------------------------------

const EXECUTOR_SOURCE = readFileSync(join(__dirname, 'actionExecutor.ts'), 'utf8');

// 行コメントを落とす。コメント内の "INSERT経路" のような記述を書き込みとして
// 誤検出しないため（文字列内の "https://" も潰れるが、キーワード検出には無害）。
const EXECUTOR_CODE = EXECUTOR_SOURCE.split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

// 書き込みの目印: 生SQLと、書き込みを担う既知のヘルパ関数。
const MUTATION_PATTERNS: RegExp[] = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+[a-z_]+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bcreateRule\(/,
  /\bupdateRule\(/,
  /\bdeleteRule\(/,
  /\bupdateGapStatus\(/,
  /\bsaveMessage\(/,
  /\bresolveEscalation\(/,
  /\brecordOutcome\(/,
  /\bdeleteSession\(/,
  /\bsubmitSaiTask\(/,
  /\bactivateAvatarConfig\(/,
  /\bcommitTextFaqs\(/,
  /\bcommitScrapeFaqs\(/,
  /\bapproveGapRecommendation\(/,
  /\baddKnowledgeFromGap\(/,
];

/** executeToolCall の switch を case ごとに切り、書き込みを行っているツール名を返す。 */
function detectMutatingToolsFromExecutor(): Set<string> {
  const toolNames = new Set(ALL_TOOL_NAMES);
  const caseRe = /case '([a-z_0-9]+)':/g;
  const boundaries: Array<{ name: string; start: number }> = [];

  for (let m = caseRe.exec(EXECUTOR_CODE); m !== null; m = caseRe.exec(EXECUTOR_CODE)) {
    boundaries.push({ name: m[1]!, start: m.index });
  }

  const mutating = new Set<string>();
  // switch 内には result.reason に対する入れ子の case もあるため、
  // ツール名の case を見つけたときだけ帰属先を更新する。
  let owner: string | null = null;

  for (let i = 0; i < boundaries.length; i++) {
    const { name, start } = boundaries[i]!;
    if (toolNames.has(name)) owner = name;
    if (owner === null) continue;

    const end = i + 1 < boundaries.length ? boundaries[i + 1]!.start : EXECUTOR_CODE.length;
    const body = EXECUTOR_CODE.slice(start, end);
    if (MUTATION_PATTERNS.some((re) => re.test(body))) mutating.add(owner);
  }

  return mutating;
}

describe('confirmPolicy: actionExecutor.ts の実装との突き合わせ', () => {
  const mutating = detectMutatingToolsFromExecutor();

  it('書き込みを行っている case はすべてリスク階層表に登録されている', () => {
    const missing = [...mutating].filter((name) => !(name in WRITE_TOOL_RISK_TIERS));
    expect(missing).toEqual([]);
  });

  it('リスク階層表と実装側の書き込み一覧が完全に一致する', () => {
    // 片側に寄せた subset ではなく厳密一致で見る。ここが落ちる場合は
    // (a) 表に古いエントリが残っている、または
    // (b) 新しい書き込みヘルパを使い始めたので MUTATION_PATTERNS に追加が必要、のどちらか。
    expect([...mutating].sort()).toEqual(Object.keys(WRITE_TOOL_RISK_TIERS).sort());
  });

  it('非書き込みとして分類したツールが実際には書き込んでいない', () => {
    const contradictions = NON_WRITE_TOOLS.filter((name) => mutating.has(name));
    expect(contradictions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// フロントの REAL_WRITE_TOOLS（実書き込み回数のカウント対象）との突き合わせ。
// 双方が独立に「書き込みツール一覧」を持っているため、片方だけ増えるのを防ぐ。
// ---------------------------------------------------------------------------

function readFrontendRealWriteTools(): string[] {
  const path = join(__dirname, '../../../../admin-ui/src/pages/copilot-preview/index.tsx');
  const source = readFileSync(path, 'utf8');
  const block = source.match(/const REAL_WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) {
    throw new Error(`REAL_WRITE_TOOLS not found in ${path} — 名称かファイル位置が変わった場合はこのテストも更新する`);
  }
  return [...block[1]!.matchAll(/["']([a-z_0-9]+)["']/g)].map((m) => m[1]!);
}

describe('confirmPolicy: フロントの REAL_WRITE_TOOLS との突き合わせ', () => {
  it('フロントが書き込みと見なしているツールはすべてリスク階層表に登録されている', () => {
    const missing = readFrontendRealWriteTools().filter((name) => !(name in WRITE_TOOL_RISK_TIERS));
    expect(missing).toEqual([]);
  });

  // 上のテストは「フロント ⊆ サーバ」しか見ておらず、逆方向(サーバに書き込みツールを
  // 追加したのにフロントの実書き込みカウント対象への追加を忘れる)を検出できなかった。
  // 実際に record_session_outcome / delete_chat_session を含む10ツールがこの穴を
  // 通り抜けて RealActionBadge の集計から漏れていた(発見時点のレビューで判明)。
  it('リスク階層表の書き込みツールはすべてフロントの REAL_WRITE_TOOLS にも登録されている', () => {
    const front = new Set(readFrontendRealWriteTools());
    const missing = Object.keys(WRITE_TOOL_RISK_TIERS).filter((name) => !front.has(name));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// フロントの REAL_TOOL_LABEL（画面に出す日本語ラベル）との突き合わせ。
//
// CLAUDE.md「実装の置き場所」は、ツール追加を
//   toolDefinitions.ts + actionExecutor.ts の case + copilot-preview の REAL_TOOL_LABEL
// の3点セットと定めたうえで、REAL_TOOL_LABEL だけは
//   「網羅性を強制するテストが無く、人力で守る唯一の箇所」
// と明記していた。src/api/admin/CLAUDE.md の「ツールを追加・変更するときの必須手順」も
// 手順4として同じことを人力に委ねている。
//
// ラベルが漏れると CardView は `REAL_TOOL_LABEL[card.tool] ?? card.tool` で
// フォールバックするため、例外も型エラーも出ないまま
// 画面に生の英語ツール名（例: set_avatar_feature）がテナントに表示される。
// 静かに壊れる＝レビューでしか気づけない、という性質のため機械検査を置く。
// ---------------------------------------------------------------------------

function readFrontendRealToolLabels(): string[] {
  const path = join(__dirname, '../../../../admin-ui/src/pages/copilot-preview/index.tsx');
  const source = readFileSync(path, 'utf8');
  const block = source.match(/const REAL_TOOL_LABEL: Record<string, string> = \{([\s\S]*?)\n\};/);
  if (!block) {
    throw new Error(`REAL_TOOL_LABEL not found in ${path} — 名称かファイル位置が変わった場合はこのテストも更新する`);
  }
  // キーは素の識別子（set_ga4_id のように数字を含むものがある）。値側の文字列を拾わないよう
  // 行頭のキー位置に限定する。
  return [...block[1]!.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]!);
}

describe('confirmPolicy: フロントの REAL_TOOL_LABEL との突き合わせ', () => {
  it('全ツールにフロントの日本語ラベルがある（漏れると画面に生の英語ツール名が出る）', () => {
    const labels = new Set(readFrontendRealToolLabels());
    const missing = ALL_TOOL_NAMES.filter((name) => !labels.has(name));
    expect(missing).toEqual([]);
  });

  it('存在しないツールのラベルが残っていない（ツール削除時の掃除漏れ検出）', () => {
    const known = new Set(ALL_TOOL_NAMES);
    const stale = readFrontendRealToolLabels().filter((name) => !known.has(name));
    expect(stale).toEqual([]);
  });

  it('ラベルが重複していない（同じキーを二重定義すると後勝ちで片方が死ぬ）', () => {
    const labels = readFrontendRealToolLabels();
    const seen = new Set<string>();
    const duplicated = labels.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
    expect(duplicated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 確認フラグ(confirmed)の読み取り方が1箇所に集約されていることの検証。
//
// かつては Boolean(args['confirmed']) と args['confirmed'] === true の2方式が
// 混在していた。前者は Boolean('false') === true という JS の仕様により、
// 文字列 'false' を「確認済み」と誤判定する。本リポジトリでは Groq が引数を
// 文字列化して送ってくる事象が実測されている（agentRoutes.ts の parseToolArgs
// のコメント参照）ため、この誤判定は机上のものではない。
//
// 判定を isConfirmed() へ集約したうえで、素の読み取りが再び現れないことを
// ここで機械的に防ぐ。
// ---------------------------------------------------------------------------

describe('confirmPolicy: 確認フラグの読み取りが isConfirmed() に集約されている', () => {
  // args['confirmed'] を isConfirmed() に渡す形以外で参照している箇所を検出する。
  // 許可されるのは isConfirmed(args['confirmed']) の形のみ。
  const RAW_CONFIRMED_READS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /Boolean\(\s*args\[['"]confirmed['"]\]\s*\)/g, label: "Boolean(args['confirmed'])" },
    { pattern: /args\[['"]confirmed['"]\]\s*===/g, label: "args['confirmed'] ===" },
    { pattern: /args\[['"]confirmed['"]\]\s*==[^=]/g, label: "args['confirmed'] ==" },
    { pattern: /!\s*args\[['"]confirmed['"]\]/g, label: "!args['confirmed']" },
  ];

  it('Boolean() や === による素の確認フラグ読み取りが残っていない', () => {
    const found = RAW_CONFIRMED_READS.flatMap(({ pattern, label }) =>
      (EXECUTOR_CODE.match(pattern) ?? []).map(() => label),
    );
    expect(found).toEqual([]);
  });

  it('確認フラグを読む箇所はすべて isConfirmed() を経由している', () => {
    // args['confirmed'] の総出現回数と、isConfirmed(args['confirmed']) の出現回数が一致すること。
    // 片方だけ増えた場合（新しいツールが素の読み取りを書いた場合）に落ちる。
    const allReads = (EXECUTOR_CODE.match(/args\[['"]confirmed['"]\]/g) ?? []).length;
    const viaHelper = (EXECUTOR_CODE.match(/isConfirmed\(\s*args\[['"]confirmed['"]\]\s*\)/g) ?? []).length;
    expect(viaHelper).toBe(allReads);
  });
});

// ---------------------------------------------------------------------------
// requiresConfirmation の挙動（本タスクの時点では階層によらず一律 true）
// ---------------------------------------------------------------------------

describe('requiresConfirmation', () => {
  const samples: Array<[RiskTier, string]> = [
    ['low', 'set_ga4_id'],
    ['low', 'dismiss_knowledge_gap'],
    ['medium', 'save_faq'],
    ['medium', 'update_engagement_rule'],
    ['high', 'delete_faq'],
    ['high', 'request_sai_task'],
  ];

  it.each(samples)('%s の %s も確認ゲートの対象（階層による緩和はしない）', (tier, tool) => {
    expect(WRITE_TOOL_RISK_TIERS[tool]).toBe(tier);
    expect(requiresConfirmation(tool)).toBe(true);
  });

  it('分類済みの書き込みツールすべてで true を返す', () => {
    for (const tool of Object.keys(WRITE_TOOL_RISK_TIERS)) {
      expect(requiresConfirmation(tool)).toBe(true);
    }
  });

  it('未分類のツール名は黙って false にせず例外を投げる', () => {
    expect(() => requiresConfirmation('brand_new_write_tool')).toThrow('Unclassified write tool: brand_new_write_tool');
  });

  it('読み取り専用ツールも階層表には無いため例外になる（誤用の検出）', () => {
    expect(() => requiresConfirmation('get_faq_list')).toThrow('Unclassified write tool: get_faq_list');
  });
});
