#!/usr/bin/env tsx
// SCRIPTS/seed-r2c-docs.ts
// R2C（RAJIUCE）サービスの使い方ナレッジをtenant_id='r2c_docs'として投入する。
// QA AIが管理者の「R2Cの使い方」質問に答えられるようになる。
//
// 実行: npx tsx SCRIPTS/seed-r2c-docs.ts [--dry-run]

import 'dotenv/config';
// @ts-ignore
import { Pool } from 'pg';
import { embedText } from '../src/agent/llm/openaiEmbeddingClient';

const TENANT_ID = 'r2c_docs';

const FAQS: Array<{ question: string; answer: string; category: string }> = [
  // ウィジェット設置
  {
    question: 'R2CのAIチャットウィジェットをWebサイトに設置するにはどうすればよいですか？',
    answer: '管理画面の「テナント管理」→テナント詳細→「埋め込みコード」タブからコードをコピーし、WebサイトのHTMLに貼り付けてください。コード内の「YOUR_API_KEY」を「APIキー」タブで発行した実際のキーに置き換えてください。',
    category: 'general',
  },
  // APIキー
  {
    question: 'APIキーの発行方法を教えてください。',
    answer: '管理画面の「テナント管理」→テナント詳細→「APIキー」タブから「新しいAPIキーを発行」ボタンで発行できます。APIキーは発行時にのみ表示されますので、必ずメモしてください。',
    category: 'general',
  },
  {
    question: '複数のAPIキーを発行できますか？',
    answer: 'はい、1テナントに対して複数のAPIキーを発行できます。用途ごとにキーを分けることでセキュリティ管理が容易になります。',
    category: 'general',
  },
  {
    question: 'APIキーが漏洩した場合どうすればよいですか？',
    answer: 'テナント詳細の「APIキー」タブから該当キーの「無効化」ボタンを押して即座に失効させ、新しいAPIキーを再発行してください。',
    category: 'general',
  },
  // FAQ登録
  {
    question: 'FAQの登録方法は何種類ありますか？',
    answer: 'テキスト貼り付け・PDF資料のアップロード（OCR）・WebサイトURLからのスクレイピング・手動入力の4種類があります。管理画面の「AIの知識データ」ページから選択できます。',
    category: 'general',
  },
  {
    question: 'PDFをアップロードしてFAQを自動生成できますか？',
    answer: 'はい、「AIの知識データ」→「PDF資料のアップロード（OCR）」からPDFを選択するとAIが内容を解析してFAQを自動生成します。',
    category: 'general',
  },
  {
    question: 'WebサイトのURLからFAQを自動生成できますか？',
    answer: 'はい、「AIの知識データ」→「WebサイトのURLを入力」に最大5件のURLを1行1件で入力すると、AIがページ内容を読み取りFAQを自動生成します。',
    category: 'general',
  },
  {
    question: '登録したFAQを編集・削除するにはどうすればよいですか？',
    answer: '「AIの知識データ」ページのFAQ一覧から編集（鉛筆）または削除（ゴミ箱）ボタンをクリックしてください。',
    category: 'general',
  },
  {
    question: 'FAQに全テナント共通のデータを登録できますか？',
    answer: '「AIの知識データ」ページの「全店舗共通の知識データとして登録」オプションを選ぶことでグローバルFAQとして全テナントのAIに反映されます（スーパー管理者のみ）。',
    category: 'general',
  },
  // チャットテスト
  {
    question: 'チャットの動作をテストするにはどうすればよいですか？',
    answer: '管理画面の「チャットをテストする」ページでテナントとAPIキーを選択すると、お客様と同じ画面でチャットの動作を確認できます。',
    category: 'general',
  },
  // テナント管理
  {
    question: '新しいテナントを追加するにはどうすればよいですか？',
    answer: 'スーパー管理者として「テナント管理」ページの「新しいテナントを追加」ボタンから、テナント名とスラッグ（英数字・ハイフンのみ）を入力して作成できます。',
    category: 'general',
  },
  {
    question: 'ウィジェットを設置するWebサイトのドメインを制限できますか？',
    answer: 'はい、テナント詳細の「設定」タブ→「許可ドメイン」にWebサイトのURLを1行1件で登録することでCORSを制限できます。未設定の場合はセキュリティ上のリスクがあるため必ず設定してください。',
    category: 'general',
  },
  {
    question: 'テナントのプランを変更するにはどうすればよいですか？',
    answer: 'テナント詳細の「設定」タブからプランを変更できます（スーパー管理者のみ）。変更は即座に反映されます。',
    category: 'general',
  },
  // AIカスタマイズ
  {
    question: 'AIの返答スタイルをカスタマイズできますか？',
    answer: 'はい、テナント詳細の「システムプロンプト」欄にAIへの指示を入力することで返答スタイルを変更できます。また「AIへの指示ルール」でキーワードごとの細かいルール設定も可能です。',
    category: 'general',
  },
  {
    question: 'AIへの指示ルール（チューニングルール）とは何ですか？',
    answer: '特定のキーワードが含まれる質問に対してAIの返答スタイルを制御する機能です。「AIへの指示ルール」ページからトリガーキーワードと期待する応答ルールを設定できます。例：「返品」というキーワードに対して特定の説明文を返すよう設定できます。',
    category: 'general',
  },
  // 会話履歴・分析
  {
    question: 'お客様との会話履歴を確認できますか？',
    answer: 'はい、管理画面の「会話履歴」ページでお客様とAIのすべての会話ログを確認できます。',
    category: 'general',
  },
  {
    question: 'AIが回答できなかった質問を確認できますか？',
    answer: '「未回答の質問」ページでAIが回答できなかった質問の一覧を確認でき、そこからFAQを追加してAIを改善できます。',
    category: 'general',
  },
  {
    question: 'チャットのコンバージョン効果を分析できますか？',
    answer: '「成約・効果分析」ページでAIチャット経由のコンバージョン数や成約率を確認できます。',
    category: 'general',
  },
  {
    question: 'フィードバック（お客様の評価）を確認できますか？',
    answer: '「フィードバック」ページでお客様がチャットに付けた評価を一覧で確認できます。',
    category: 'general',
  },
  // アバター
  {
    question: 'アバター（AIキャラクター）を設定するにはどうすればよいですか？',
    answer: '管理画面の「アバター」ページでデフォルトアバターを選択し、「有効化」ボタンを押すとチャットウィジェットに表示されます。有効化できるアバターは1テナントにつき1体です。',
    category: 'general',
  },
  {
    question: 'アバターに音声（TTS）機能はありますか？',
    answer: 'はい、一部のアバターには音声読み上げ機能が搭載されており、AIの回答をキャラクターが音声で読み上げます。',
    category: 'general',
  },
  // 請求・利用量
  {
    question: '利用状況や請求を確認するにはどうすればよいですか？',
    answer: '管理画面の「請求・使用量」ページでテナントごとのリクエスト数・トークン数・コストを月別に確認できます。CSVでダウンロードすることも可能です。',
    category: 'general',
  },
  // 声がけ・エンゲージメント
  {
    question: 'お客様への自動声がけ機能がありますか？',
    answer: 'はい、「お客様への声がけ設定」ページから、お客様の行動（ページ滞在時間・閲覧ページ数など）に合わせて自動でチャットメッセージを送る設定ができます。',
    category: 'general',
  },
  // ログイン・アカウント
  {
    question: '管理画面にログインできないときはどうすればよいですか？',
    answer: '管理画面はSupabase認証を使用しています。パスワードを忘れた場合はログインページの「パスワードを忘れた方」からリセットしてください。',
    category: 'general',
  },
  // モバイル
  {
    question: 'モバイル端末でウィジェットを使えますか？',
    answer: 'はい、ウィジェットはモバイルファーストで設計されており、スマートフォンやタブレットでも快適に利用できます。',
    category: 'general',
  },
  // R2C概要
  {
    question: 'R2CのAIはどのような質問に答えられますか？',
    answer: '登録されたFAQ・PDF・Webページの内容をもとに回答します。登録されていない内容については「詳しくはお問い合わせください」と案内します。R2Cの管理画面の使い方についても回答できます。',
    category: 'general',
  },
];

const isDryRun = process.argv.includes('--dry-run');

async function upsertToEs(esUrl: string, tenantId: string, faqId: number, question: string, answer: string): Promise<void> {
  const index = `faq_${tenantId}`;
  const docId = `${faqId}_${tenantId}`;
  const url = `${esUrl.replace(/\/$/, '')}/${index}/_doc/${encodeURIComponent(docId)}`;
  const doc = { tenant_id: tenantId, question, answer, faq_id: faqId, is_published: true, is_excluded_from_search: false };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    console.warn(`  [ES] upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  const esUrl = process.env.ES_URL;

  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`FAQs to seed: ${FAQS.length}\n`);

  let inserted = 0;
  let skipped = 0;

  try {
    for (const faq of FAQS) {
      // 冪等チェック: 同じ質問が既に存在するか確認
      const exists = await pool.query<{ id: number }>(
        'SELECT id FROM faq_docs WHERE tenant_id = $1 AND question = $2 LIMIT 1',
        [TENANT_ID, faq.question]
      );

      if (exists.rows.length > 0) {
        console.log(`  SKIP (exists): ${faq.question.slice(0, 50)}`);
        skipped++;
        continue;
      }

      if (isDryRun) {
        console.log(`  [DRY RUN] INSERT: ${faq.question.slice(0, 60)}`);
        inserted++;
        continue;
      }

      // faq_docs に挿入
      const result = await pool.query<{ id: number }>(
        `INSERT INTO faq_docs (tenant_id, question, answer, category, tags, is_published)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id`,
        [TENANT_ID, faq.question, faq.answer, faq.category, '{}']
      );
      const faqId = result.rows[0]!.id;

      // 埋め込みベクトルを生成して faq_embeddings に挿入
      const embText = `${faq.question}\n${faq.answer}`;
      try {
        const vec = await embedText(embText);
        const embLiteral = `[${vec.join(',')}]`;
        await pool.query(
          `INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata, is_excluded_from_search)
           VALUES ($1, $2, $3::vector, $4::jsonb, false)`,
          [TENANT_ID, embText, embLiteral, JSON.stringify({ source: 'faq_crud', faq_id: faqId })]
        );
      } catch (embErr) {
        console.warn(`  [WARN] embedding failed for FAQ id=${faqId}: ${(embErr as Error).message}`);
      }

      // ES インデックスに upsert
      if (esUrl) {
        await upsertToEs(esUrl, TENANT_ID, faqId, faq.question, faq.answer);
      }

      console.log(`  INSERT id=${faqId}: ${faq.question.slice(0, 60)}`);
      inserted++;
    }

    // 結果確認
    if (!isDryRun) {
      const countResult = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM faq_docs WHERE tenant_id = $1`,
        [TENANT_ID]
      );
      const embCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM faq_embeddings WHERE tenant_id = $1`,
        [TENANT_ID]
      );
      console.log(`\nDone. faq_docs: ${countResult.rows[0]!.cnt} rows, faq_embeddings: ${embCount.rows[0]!.cnt} rows`);
    }

    console.log(`\nInserted: ${inserted}, Skipped: ${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
