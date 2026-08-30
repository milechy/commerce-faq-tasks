import { readFileSync } from "fs";
import { resolve } from "path";

// carnation-demo の reservation/inquiry/purchase は URLクエリ(car_name / price)を
// 画面に反映する。以前は decodeURIComponent(carName) 等を innerHTML 連結で挿入しており
// reflected XSS(例: <img src=x onerror=...>)が成立していた。修正で textContent 経由の
// DOM 構築に置き換えたため、クエリ由来値が innerHTML に流れる連結が復活していないことを
// 静的に検査してリグレッションを防ぐ。
const DEMO_DIR = resolve(process.cwd(), "public/carnation-demo");

function read(file: string): string {
  return readFileSync(resolve(DEMO_DIR, file), "utf8");
}

describe("carnation-demo reflected XSS regression guard", () => {
  const files = ["reservation.html", "inquiry.html", "purchase.html"];

  it.each(files)(
    "%s does not concatenate a query-derived value into innerHTML",
    (file) => {
      const html = read(file);
      // クエリ由来値(carName / displayName)を innerHTML に直接連結する古いパターンを禁止。
      expect(html).not.toMatch(/innerHTML\s*=[^;]*decodeURIComponent\s*\(\s*carName/);
      expect(html).not.toMatch(/innerHTML\s*=[^;]*\+\s*displayName/);
      expect(html).not.toMatch(/innerHTML\s*=[^;]*\+\s*carName/);
    }
  );

  it.each(files)("%s reflects the query value via textContent", (file) => {
    const html = read(file);
    expect(html).toMatch(/\.textContent\s*=/);
  });
});
