// src/index.routeRegistrationOrder.test.ts
//
// 再発防止(Asana GID 1218086285251452): registerAdminFeedbackManagementRoutes(app) が
// registerFeedbackRoutes(app) より先に登録されていたため、Express の「登録順で最初に
// マッチしたルートが終端する」性質により後続の GET/POST /v1/admin/feedback や
// PATCH /v1/admin/feedback/read（先に登録された PATCH /v1/admin/feedback/:id の
// :id="read" に食われる）が到達不能になっていた。この事故は型では守れず、実行時に
// しか壊れない「ルート登録順序」という不変条件を破ったために起きた。
//
// src/index.ts は app.listen() を含む起動エントリポイントで DB/ES接続などの副作用を
// 伴うため supertest で丸ごと import して統合テストすることができない
// (index.wiringInvariants.test.ts と同じ制約)。そのためソースを直接読んで、
// 実際に Express へ登録される順序を静的に再構成し、「後から登録されたパスが、
// 先に登録されたパターンに食われて到達不能になっている」組み合わせを機械的に検出する。

import { readFileSync, existsSync } from "fs";
import { dirname, join, relative, resolve } from "path";

const SRC_DIR = __dirname; // src/
const INDEX_PATH = join(SRC_DIR, "index.ts");

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"] as const;

interface RouteEntry {
  method: string;
  path: string;
  /** グローバル登録順（小さいほど先に登録される） */
  order: number;
  /** デバッグ用: どのファイルの記述か（src/ からの相対パス） */
  source: string;
}

// ---------------------------------------------------------------------------
// import { a, b as c } from "./relative/module" を { ローカル名 -> モジュールパス } に解決
// ---------------------------------------------------------------------------
function extractImportMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(source))) {
    const names = im[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const parts = n.split(/\s+as\s+/);
      const localName = (parts[1] ?? parts[0])!.trim();
      map.set(localName, im[2]!);
    }
  }
  return map;
}

function resolveModuleFile(fromDir: string, modPath: string): string | null {
  const base = resolve(fromDir, modPath);
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1ファイル分のソースを走査し、「app.<method>(...)」という直接呼び出しと、
// 「someImportedFn(app, ...)」というルート登録関数呼び出しを、出現位置(pos)順の
// トークン列として抽出する。登録関数呼び出しは再帰的に解決してそのファイルの
// ルート列をこの位置に展開する(例: registerKnowledgeAdminRoutes が内部で
// registerFaqCrudRoutes/registerBookPdfRoutes を呼んでいるケース)。
// ---------------------------------------------------------------------------
let globalOrder = 0;

function collectRoutes(filePath: string, trail: string[]): RouteEntry[] {
  if (trail.includes(filePath)) return []; // 循環参照ガード
  const source = readFileSync(filePath, "utf-8");
  const fileDir = dirname(filePath);
  const importMap = extractImportMap(source);
  const label = relative(SRC_DIR, filePath);

  type Tok =
    | { pos: number; kind: "inline"; method: string; path: string }
    | { pos: number; kind: "call"; name: string };
  const toks: Tok[] = [];

  const inlineRe = /app\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  let mm: RegExpExecArray | null;
  while ((mm = inlineRe.exec(source))) {
    toks.push({ pos: mm.index, kind: "inline", method: mm[1]!.toUpperCase(), path: mm[2]! });
  }

  // "function registerXRoutes(app: Express..." という自分自身の宣言はスキップする
  // (これも "identifier(app" にマッチしてしまうため)
  const callRe = /(?<!function\s)\b([A-Za-z_$][A-Za-z0-9_$]*)\(\s*app\b/g;
  let cm: RegExpExecArray | null;
  while ((cm = callRe.exec(source))) {
    const name = cm[1]!;
    if (name === "app") continue;
    toks.push({ pos: cm.index, kind: "call", name });
  }

  toks.sort((a, b) => a.pos - b.pos);

  const result: RouteEntry[] = [];
  for (const tok of toks) {
    if (tok.kind === "inline") {
      result.push({ method: tok.method, path: tok.path, order: globalOrder++, source: label });
    } else {
      const modPath = importMap.get(tok.name);
      if (!modPath) continue; // このファイルで定義/importされていない識別子（無関係な関数）
      const resolved = resolveModuleFile(fileDir, modPath);
      if (!resolved) continue;
      result.push(...collectRoutes(resolved, [...trail, filePath]));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// :param セグメントを1セグメントにマッチするワイルドカードとして扱う
// (Express の実際のマッチング規則を模した簡易版。ワイルドカード(*)・正規表現ルート等
// このコードベースで未使用の記法は非対応)
// ---------------------------------------------------------------------------
function pathToRegex(pattern: string): RegExp {
  const segments = pattern.split("/").map((seg) =>
    seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`^${segments.join("/")}$`);
}

interface Collision {
  earlier: RouteEntry;
  later: RouteEntry;
}

function findCollisions(routes: RouteEntry[]): Collision[] {
  const collisions: Collision[] = [];
  const byMethod = new Map<string, RouteEntry[]>();
  for (const r of routes) {
    const list = byMethod.get(r.method) ?? [];
    list.push(r);
    byMethod.set(r.method, list);
  }
  for (const list of byMethod.values()) {
    const sorted = [...list].sort((a, b) => a.order - b.order);
    for (let i = 0; i < sorted.length; i++) {
      const earlier = sorted[i]!;
      const earlierRe = pathToRegex(earlier.path);
      for (let j = i + 1; j < sorted.length; j++) {
        const later = sorted[j]!;
        if (earlierRe.test(later.path)) {
          collisions.push({ earlier, later });
        }
      }
    }
  }
  return collisions;
}

describe("ルート登録順序の衝突検出(再発防止・GID 1218086285251452)", () => {
  it("index.ts から到達可能な全ルートを静的に走査できる(0件は抽出ロジック破損の疑い)", () => {
    globalOrder = 0;
    const routes = collectRoutes(INDEX_PATH, []);
    expect(routes.length).toBeGreaterThan(50);
  });

  it("後から登録されたルートが、先に登録された同メソッドのパターンに食われて到達不能になっている組み合わせが無い", () => {
    globalOrder = 0;
    const routes = collectRoutes(INDEX_PATH, []);
    const collisions = findCollisions(routes);

    if (collisions.length > 0) {
      const detail = collisions
        .map(
          (c) =>
            `  [${c.later.method}] ${c.earlier.source}:"${c.earlier.path}" (先) が ${c.later.source}:"${c.later.path}" (後) を食っています`
        )
        .join("\n");
      throw new Error(
        `ルート登録順序の衝突を検出しました。後から登録されたルートは到達不能です:\n${detail}\n` +
          `→ 到達不能になっている側を先に登録するか、パスの重複/包含を解消してください。`
      );
    }
    expect(collisions).toEqual([]);
  });

  // 具体事故の回帰pin: /v1/admin/feedback/:id のような可変セグメントルートが
  // 固定セグメント(/v1/admin/feedback/read 等)を持つ後続ルートを食う典型パターン。
  // ここでは pathToRegex の判定ロジック自体が意図どおり動くことを直接固定する。
  it("[判定ロジック pin] PATCH /v1/admin/feedback/:id は PATCH /v1/admin/feedback/read を食う(:id='read')", () => {
    const re = pathToRegex("/v1/admin/feedback/:id");
    expect(re.test("/v1/admin/feedback/read")).toBe(true);
  });

  it("[判定ロジック pin] GET /v1/admin/feedback/threads は GET /v1/admin/feedback/:id を食わない(セグメント数が違う場合は無関係)", () => {
    const re = pathToRegex("/v1/admin/feedback/threads");
    expect(re.test("/v1/admin/feedback/other-id")).toBe(false);
  });
});
