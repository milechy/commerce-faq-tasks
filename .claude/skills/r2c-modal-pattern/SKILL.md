---
name: r2c-modal-pattern
description: R2C Admin UI（React + Vite + Shadcn UI + Tailwind）でモーダル・ダイアログ・フォーム・ボタン・テーブルを実装する際、既存パターンに厳密に追従する。新規コンポーネントを発明せず、既存の Dialog / Sheet / Form / Button / Table コンポーネントを使い回す。ITリテラシ低パートナー向けにタッチターゲット44px以上・モバイル390pxレスポンシブ・ドラッグ&ドロップ対応を保証する。トリガー: admin-ui/ 配下のコンポーネント追加 / モーダル実装 / フォーム実装 / ファイルアップロードUI / 確認ダイアログ / Gate 6 U1-U8チェック対応時。Phase39で確立したUI品質基準とPhase49のダークテーマを維持するため。
version: 1.0.0
---

# R2C Admin UI 実装パターン（既存踏襲ルール）

新規UIを発明しない。既存の組み合わせで作る。これがGate 6 U1（レイアウト一貫性）を守る唯一の方法。

## 技術スタック前提

- **React 18 + Vite + TypeScript**
- **Shadcn UI**（Radix UI ベース）
- **Tailwind CSS**（ダークテーマ統一: Phase39）
- **Lucide React**（アイコン）
- **react-hook-form + zod**（フォームバリデーション）

## 必須デザイントークン

### タッチターゲット（厳守）

```tsx
// ✅ OK: 44px以上
<Button className="h-11 px-4">追加</Button>          // h-11 = 44px
<Button size="lg" className="h-12">保存</Button>     // h-12 = 48px

// ❌ NG: 44px未満
<Button size="sm" className="h-8">追加</Button>      // h-8 = 32px (small画面で押しにくい)
```

例外: テーブル行内のアイコンボタンのみ `h-8` 許可（ただしクリック領域に `p-2` 確保）

### フォントサイズ

- 本文: `text-base` (16px) — 最小限
- 補足: `text-sm` (14px) — ヒント・説明文のみ
- 見出し: `text-lg` / `text-xl` / `text-2xl`
- 11px / 12px は使わない（パートナーが読めない）

### ブレークポイント（モバイルファースト）

```tsx
// Phase39: 390px / 768px / 1024px の3点で崩れない
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
```

## 既存コンポーネントカタログ

実装前に必ず `admin-ui/src/components/ui/` を確認。以下は既存にあるはず:

| コンポーネント | パス | 用途 |
|---|---|---|
| Dialog | `components/ui/dialog.tsx` | モーダル（中央表示） |
| Sheet | `components/ui/sheet.tsx` | サイドパネル（右/左から） |
| AlertDialog | `components/ui/alert-dialog.tsx` | 確認ダイアログ（破壊的操作） |
| Form | `components/ui/form.tsx` | react-hook-form + zod |
| Button | `components/ui/button.tsx` | ボタン全般 |
| Input | `components/ui/input.tsx` | テキスト入力 |
| Textarea | `components/ui/textarea.tsx` | 複数行入力 |
| Select | `components/ui/select.tsx` | プルダウン |
| Table | `components/ui/table.tsx` | テーブル |
| Toast | `lib/toast.ts` | 通知（sonner ベース） |
| Skeleton | `components/ui/skeleton.tsx` | ローディング |
| Card | `components/ui/card.tsx` | カード |
| Badge | `components/ui/badge.tsx` | バッジ |

**新規追加前のルール**: `components/ui/` に類似コンポーネントがないか必ず `grep` してから判断。

## パターン1: 確認ダイアログ（破壊的操作）

削除・公開・送信など「やり直しが難しい操作」は必ず AlertDialog で確認:

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="destructive">この書籍を削除</Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>本当に削除しますか？</AlertDialogTitle>
      <AlertDialogDescription>
        「{bookTitle}」を削除します。この操作は取り消せません。
        AIの回答からも参照されなくなります。
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>やめる</AlertDialogCancel>
      <AlertDialogAction onClick={handleDelete} className="bg-destructive">
        削除する
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**ポイント:**
- タイトルは疑問形（「本当に削除しますか？」）
- 説明文に「何が起きるか」を書く
- キャンセル文言は「キャンセル」より「やめる」が優しい
- 破壊的アクションは赤（`bg-destructive`）

## パターン2: フォーム（react-hook-form + zod）

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";

const schema = z.object({
  title: z.string().min(1, "タイトルは入力が必要です").max(100, "タイトルは100文字までで入力してください"),
  description: z.string().max(500, "説明は500文字までで入力してください").optional(),
});

const form = useForm<z.infer<typeof schema>>({
  resolver: zodResolver(schema),
  defaultValues: { title: "", description: "" }
});

<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
    <FormField
      control={form.control}
      name="title"
      render={({ field }) => (
        <FormItem>
          <FormLabel>タイトル <span className="text-destructive">*</span></FormLabel>
          <FormControl>
            <Input {...field} placeholder="例: 影響力の武器" className="h-11" />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
    <Button type="submit" className="h-11 w-full md:w-auto">保存</Button>
  </form>
</Form>
```

**ポイント:**
- エラーメッセージは zod スキーマで日本語化（`r2c-gentle-error` 規則）
- 必須項目には `*` を赤で表示
- placeholder に「例:」を入れて期待値を示す
- ボタンはモバイルで full-width、PCで auto

## パターン3: ファイルアップロード（ドラッグ&ドロップ）

ITリテラシ低パートナー向け。クリックでもD&Dでも動くこと。

```tsx
import { useDropzone } from "react-dropzone";
import { Upload } from "lucide-react";

const { getRootProps, getInputProps, isDragActive } = useDropzone({
  accept: { "application/pdf": [".pdf"] },
  maxSize: 50 * 1024 * 1024,  // 50MB
  multiple: false,
  onDrop: handleUpload,
});

<div
  {...getRootProps()}
  className={cn(
    "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer",
    "min-h-[200px] flex flex-col items-center justify-center gap-2",
    isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
  )}
>
  <input {...getInputProps()} />
  <Upload className="h-12 w-12 text-muted-foreground" />
  {isDragActive ? (
    <p className="text-base font-medium">ここに離してね 📚</p>
  ) : (
    <>
      <p className="text-base font-medium">
        PDFファイルをドラッグ&ドロップ
      </p>
      <p className="text-sm text-muted-foreground">
        またはクリックして選択（最大50MB）
      </p>
    </>
  )}
</div>
```

## パターン4: テーブル（並び替え・ページネーション付き）

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>タイトル</TableHead>
      <TableHead>作成日</TableHead>
      <TableHead className="text-right">操作</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {books.length === 0 ? (
      <TableRow>
        <TableCell colSpan={3} className="text-center py-12">
          <p className="text-muted-foreground">
            まだ書籍が登録されていません 📚
          </p>
          <p className="text-sm mt-2">
            右上の『＋追加』ボタンから最初の1冊をアップロードしてみてください
          </p>
        </TableCell>
      </TableRow>
    ) : books.map((book) => (
      <TableRow key={book.id}>
        <TableCell className="font-medium">{book.title}</TableCell>
        <TableCell>{formatDate(book.createdAt)}</TableCell>
        <TableCell className="text-right">
          <Button variant="ghost" size="sm" onClick={() => onEdit(book)}>編集</Button>
        </TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

**ポイント:**
- 空状態はテーブル内に表示（白い画面にしない）
- 操作列は右寄せ
- モバイルではテーブルがはみ出すので、外側に `overflow-x-auto` を付ける

## パターン5: ローディング状態（Skeleton）

```tsx
{isLoading ? (
  <div className="space-y-3">
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-1/2" />
  </div>
) : (
  <Content />
)}
```

スピナーよりSkeletonを優先（レイアウトシフトしない、ユーザー体感が良い）

## ダークテーマ確認（Phase39維持）

新規コンポーネント追加時は必ず Tailwind の dark: クラスを意識:

```tsx
// ✅ Tailwind のセマンティック色を使う（dark対応自動）
<div className="bg-background text-foreground border-border">

// ❌ 固定色は使わない
<div className="bg-white text-black border-gray-200">
```

セマンティック色: `bg-background` `bg-card` `bg-muted` `text-foreground` `text-muted-foreground` `border-border` `bg-primary` `bg-destructive`

## Gate 6 U1-U8 セルフチェック

実装後、PRレビュー前に確認:

- [ ] U1: 他のページとヘッダー/サイドバー/フッターが揃っている
- [ ] U2: 390px / 768px / 1024px で崩れない
- [ ] U3: 全ボタンが 44px 以上、専門用語なし
- [ ] U4: バリデーションエラーが「優しい日本語」（→ `r2c-gentle-error`）
- [ ] U5: 読み込み中に Skeleton or スピナー表示
- [ ] U6: 空状態に「最初のアクション」誘導
- [ ] U7: ブラウザコンソールにエラー出ていない
- [ ] U8: 全メニュー項目がクリック可能で正しいページに遷移

## チェックリスト（PR作成前）

- [ ] 既存 `components/ui/` の類似コンポーネントを使い回した
- [ ] 固定色（`bg-white` 等）を使わずセマンティック色のみ
- [ ] タッチターゲット 44px 以上
- [ ] モバイル390pxでレイアウト崩れなし
- [ ] エラーメッセージが `r2c-gentle-error` 規則に準拠
- [ ] Skeleton or スピナーでローディング表示
- [ ] 空状態に誘導文あり
