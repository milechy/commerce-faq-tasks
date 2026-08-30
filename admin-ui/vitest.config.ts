import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['src/test/setup.ts'],
    // CI では既定に加えて JSON レポータを出す。
    //
    // なぜ必要か(2026-08-30 に実際に困った):
    //   Gate 3 が非決定的に落ちたとき、失敗したジョブを再実行すると
    //   GitHub Actions のログは最新の試行(=成功)で上書きされ、
    //   **失敗時のエラーと各テストの所要時間が永久に失われる**。
    //   実際、copilot-preview の findByRole が 5000ms で落ちた件を後から
    //   追おうとしたが、再実行済みのログには成功結果しか残っていなかった。
    //   ローカルでは 12 回連続で再現しないため、CI の証拠だけが手がかりになる。
    //
    // JSON には各テストの duration が入るので、次に落ちたときに
    // 「タイムアウト直前まで遅かったのか」「一瞬で失敗したのか」を切り分けられる。
    // 出力はワークフロー側で artifact として保持する(再実行では消えない)。
    reporters: process.env.CI ? ['default', 'json'] : ['default'],
    outputFile: process.env.CI ? { json: 'vitest-report.json' } : undefined,
  },
});
