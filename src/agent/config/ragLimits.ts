// src/agent/config/ragLimits.ts
// RAG抜粋のLLM渡し制限定数
//
// ナレッジ配線是正P18(Asana GID 1217811237352427): 「1件200字・最大3件」は
// 書籍由来チャンクの著作権保護のために導入した制約(全文がプロンプトに乗るのを
// 防ぐ)。この制約をテナント自身のFAQ・learned_memory由来のチャンクにまで一律
// 適用する根拠は無い。出所別に別枠(共有プールではない)を持つ。

/** 書籍由来チャンク: 1件あたりの最大文字数(著作権保護。緩めない)。 */
export const BOOK_EXCERPT_MAX_CHARS = 200;

/** 書籍由来チャンク: LLMに渡す最大件数(著作権保護。緩めない)。 */
export const BOOK_MAX_EXCERPTS = 3;

/**
 * FAQ・learned_memory由来チャンク: 1件あたりの最大文字数。
 * 著作権保護の制約が無いため書籍より余裕を持たせる(書籍の2.5倍。1件のFAQ
 * 回答として現実的な長さを収められる目安)。上限自体はGroqへの入力長・
 * レイテンシへの影響を抑えるための実務的な目安であり、法的制約ではない。
 */
export const FAQ_EXCERPT_MAX_CHARS = 500;

/**
 * FAQ・learned_memory由来チャンク: LLMに渡す最大件数。
 * 書籍の3件より広げ、検索側(topK=8。dialogOrchestrator.ts、本タスクでは変更しない)
 * の上位候補のうち書籍以外をより多く根拠にできるようにする。
 * 5件×500字×2(Q+A、synthesisTool.ts の buildFaqContext 参照)=最大5,000字
 * (日本語でおおよそ1,300〜1,700トークン程度)にプロンプト増分を抑える。
 */
export const FAQ_MAX_EXCERPTS = 5;
