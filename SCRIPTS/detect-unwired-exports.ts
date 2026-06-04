// SCRIPTS/detect-unwired-exports.ts
// Phase44–46 未配線機能の検知 (GID 1215114203188918)
//
// 「実装したものが意図通り prod から使われているか」を機械的に検知する read-only 診断ツール。
// 既存 Gate1.5 (dead-code-check.sh) は触らず additive。AST (TypeScript 5.x compiler API) で
// src/ の export を走査し、参照を prod / test / 同一ファイル内に分類して「prod 未配線」を列挙する。
//
// なぜ grep ではなく AST か:
//   - graphNodes / route registrar 等は src/index.ts 等から *静的 import* で配線されている。
//     AST の参照解決 (import 別名 → 元シンボル) はこれを正しく「wired」と判定できる。
//   - test-only 参照 (*.test.ts のみから import) を勘定に入れると「テストがある未配線関数」を
//     誤って wired 扱いしてしまう (本タスクの検知漏れ #1)。ファイル種別で参照を分類して解消する。
//
// 重要 (誤検知防止):
//   - import 文も「参照」として数える = 「import されているが未使用」を未配線と誤断定しない (安全側)。
//   - 同一ファイル内のみで使う export は 'internal-only' (export 不要かもしれないが dead ではない)。
//   - 型のみ (interface / type) は runtime 機能ではないため対象外。function/class/const/enum を対象。
//   - 本ツールは **何も削除しない**。wire するか remove するかの製品判断は人間に委ねる。
//
// 使い方:
//   npx ts-node --transpile-only SCRIPTS/detect-unwired-exports.ts            # 人間向けテーブル
//   npx ts-node --transpile-only SCRIPTS/detect-unwired-exports.ts --json     # JSON
//   npx ts-node --transpile-only SCRIPTS/detect-unwired-exports.ts --include-internal

import * as ts from 'typescript';
import * as path from 'path';

// ─── テスト可能な純粋ヘルパー ────────────────────────────────────────────────

/** *.test.ts / *.spec.ts / tests/ / __tests__/ 配下を「テストファイル」とみなす。 */
export function isTestFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return /\.(test|spec)\.[cm]?tsx?$/.test(p) || /(^|\/)(tests|__tests__)\//.test(p);
}

// 'dynamic-ref' は classifyExport (純粋な参照カウント) では返らない。
// analyze() のテキスト安全網が「AST 未配線だが prod 本文に名前が現れる」候補に後付けする
// (動的 import() / 文字列レジストリ等で AST 参照解決をすり抜ける配線を誤って未配線と断定しないため)。
export type ExportCategory =
  | 'wired'
  | 'internal-only'
  | 'test-only'
  | 'unreferenced'
  | 'dynamic-ref'
  | 'test-helper';

/**
 * テスト用に意図的に export される reset/mock ヘルパー (例: `__resetXForTests`)。
 * 「未配線機能」ではなくテスト足場なので wire/remove 候補から除外する。
 */
export function isIntentionalTestHelper(name: string): boolean {
  return /for_?tests?$/i.test(name);
}

export interface RefCounts {
  /** 宣言ファイル以外の prod ファイルからの参照数 (= 外部配線) */
  externalProd: number;
  /** 宣言ファイル内での参照数 (宣言名そのものは除く) */
  selfFile: number;
  /** *.test.ts からの参照数 */
  test: number;
}

/**
 * 参照内訳から export の配線状態を分類する。
 * 優先順位: 外部 prod 参照 > 同一ファイル内参照 > test 参照 > 参照なし。
 */
export function classifyExport(c: RefCounts): ExportCategory {
  if (c.externalProd > 0) return 'wired';
  if (c.selfFile > 0) return 'internal-only';
  if (c.test > 0) return 'test-only';
  return 'unreferenced';
}

/** 「prod 未配線」とみなすカテゴリ (人間が wire/remove を判断すべき対象)。 */
export function isProdUnwired(cat: ExportCategory): boolean {
  return cat === 'test-only' || cat === 'unreferenced';
}

// ─── AST 走査本体 ───────────────────────────────────────────────────────────

interface ExportRecord {
  name: string;
  file: string;
  kind: string;
  category: ExportCategory;
  refs: RefCounts;
}

function declKind(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableStatement(node)) return 'const';
  return null; // interface / type / その他は対象外
}

function hasExportModifier(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return (flags & ts.ModifierFlags.Export) !== 0;
}

/** identifier が「宣言名そのもの」なら true (参照として数えない)。import 指定子は参照として数える。 */
function isDeclarationName(node: ts.Identifier): boolean {
  const p = node.parent;
  return (
    ((ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isPropertySignature(p)) &&
      (p as ts.NamedDeclaration).name === node)
  );
}

function loadProgram(root: string): ts.Program {
  const tsconfigPath = path.join(root, 'tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function isSrcFile(fileName: string): boolean {
  const p = fileName.replace(/\\/g, '/');
  return p.includes('/src/') && !p.includes('/node_modules/');
}

interface RefHit {
  file: string;
  isTest: boolean;
}

export function analyze(root: string): ExportRecord[] {
  const program = loadProgram(root);
  const checker = program.getTypeChecker();
  const srcFiles = program.getSourceFiles().filter((sf) => isSrcFile(sf.fileName));

  // 1) prod (非テスト) ソースから export された runtime シンボルを収集
  const exports: { symbol: ts.Symbol; name: string; file: string; kind: string }[] = [];
  for (const sf of srcFiles) {
    if (isTestFile(sf.fileName)) continue;
    ts.forEachChild(sf, (node) => {
      if (!hasExportModifier(node)) return;
      const kind = declKind(node);
      if (!kind) return;
      const names: ts.Identifier[] = [];
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.push(d.name);
        }
      } else {
        const nm = (node as ts.NamedDeclaration).name;
        if (nm && ts.isIdentifier(nm)) names.push(nm);
      }
      for (const nameNode of names) {
        const symbol = checker.getSymbolAtLocation(nameNode);
        if (symbol) exports.push({ symbol, name: nameNode.text, file: sf.fileName, kind });
      }
    });
  }

  // 2) 全ソース(prod+test)の identifier を走査し、シンボル別に参照ファイルを記録
  const refsBySymbol = new Map<ts.Symbol, RefHit[]>();
  const record = (sym: ts.Symbol, file: string) => {
    let arr = refsBySymbol.get(sym);
    if (!arr) {
      arr = [];
      refsBySymbol.set(sym, arr);
    }
    arr.push({ file, isTest: isTestFile(file) });
  };

  for (const sf of srcFiles) {
    const fileName = sf.fileName;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        let sym = checker.getSymbolAtLocation(node);
        if (sym) {
          if (sym.flags & ts.SymbolFlags.Alias) {
            try {
              sym = checker.getAliasedSymbol(sym);
            } catch {
              // alias 解決失敗時はそのまま
            }
          }
          record(sym, fileName);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  // 3) 分類
  const results: ExportRecord[] = [];
  for (const ex of exports) {
    const hits = refsBySymbol.get(ex.symbol) ?? [];
    const counts: RefCounts = { externalProd: 0, selfFile: 0, test: 0 };
    for (const h of hits) {
      if (h.isTest) counts.test++;
      else if (h.file === ex.file) counts.selfFile++;
      else counts.externalProd++;
    }
    results.push({
      name: ex.name,
      file: path.relative(root, ex.file),
      kind: ex.kind,
      category: classifyExport(counts),
      refs: counts,
    });
  }
  // 4) テキスト安全網 (誤検知防止)
  // 動的 import() / 文字列レジストリ / 同名別シンボル等で AST 参照解決をすり抜ける配線がある。
  // test-only / unreferenced 候補について、宣言ファイル・テスト以外の prod ソース本文に
  // 識別子が単語として現れるかを走査し、現れたら 'dynamic-ref' に降格する
  // (= 「未配線」と断定しない。誤検知=ライブコード誤削除のリスクを避ける安全側に倒す)。
  const prodTexts = srcFiles
    .filter((sf) => !isTestFile(sf.fileName))
    .map((sf) => ({ file: path.relative(root, sf.fileName), text: sf.text }));
  for (const r of results) {
    if (!isProdUnwired(r.category)) continue;
    const escaped = r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    const foundInOtherProd = prodTexts.some((p) => p.file !== r.file && re.test(p.text));
    if (foundInOtherProd) r.category = 'dynamic-ref';
    else if (isIntentionalTestHelper(r.name)) r.category = 'test-helper';
  }

  // 名前重複(同名 export)を file 単位で一意化済み。安定ソート。
  results.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return results;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const includeInternal = args.includes('--include-internal');
  const root = path.resolve(__dirname, '..');

  const all = analyze(root);
  const unwired = all.filter((r) => isProdUnwired(r.category));
  const internalOnly = all.filter((r) => r.category === 'internal-only');

  const summary = {
    total: all.length,
    wired: all.filter((r) => r.category === 'wired').length,
    internalOnly: internalOnly.length,
    dynamicRef: all.filter((r) => r.category === 'dynamic-ref').length,
    testHelper: all.filter((r) => r.category === 'test-helper').length,
    testOnly: all.filter((r) => r.category === 'test-only').length,
    unreferenced: all.filter((r) => r.category === 'unreferenced').length,
  };

  if (asJson) {
    const picked = includeInternal ? [...unwired, ...internalOnly] : unwired;
    process.stdout.write(
      JSON.stringify({ summary, prodUnwired: unwired, internalOnly: includeInternal ? internalOnly : undefined, candidates: picked }, null, 2) + '\n',
    );
    return;
  }

  const fmt = (rows: ExportRecord[]) =>
    rows
      .map((r) => `  ${r.category.padEnd(13)} ${r.kind.padEnd(8)} ${r.name.padEnd(34)} ${r.file}`)
      .join('\n');

  console.log('=== detect-unwired-exports (Phase44–46 / GID 1215114203188918) ===');
  console.log(
    `total=${summary.total}  wired=${summary.wired}  internal-only=${summary.internalOnly}  dynamic-ref=${summary.dynamicRef}  test-only=${summary.testOnly}  unreferenced=${summary.unreferenced}`,
  );
  console.log('\n--- prod 未配線 (test-only / unreferenced) — wire/remove は人間判断 ---');
  console.log(unwired.length ? fmt(unwired) : '  (なし)');
  if (includeInternal) {
    console.log('\n--- internal-only (同一ファイル内のみ使用 — export 不要の可能性) ---');
    console.log(internalOnly.length ? fmt(internalOnly) : '  (なし)');
  }
}

if (require.main === module) {
  main();
}
