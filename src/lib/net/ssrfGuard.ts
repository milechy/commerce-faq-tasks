// src/lib/net/ssrfGuard.ts
//
// SSRF(Server-Side Request Forgery)対策の共通ガード。
// ユーザー/LLM が指定した URL を取得する経路（知識インポートの
// scrapeUrlToFaqs など）から利用する。
//
// 方針:
//   1. スキームは http/https のみ許可。URL 埋め込みの認証情報は拒否。
//   2. DNS 解決後の「解決先 IP」を検査し、private / loopback / link-local /
//      CGNAT / metadata(169.254.169.254) / multicast / reserved 等の
//      非グローバル宛先をブロック（IPv4 / IPv6 / IPv4-mapped IPv6 を含む）。
//      ホスト名が数値/16進/8進など変則表記でも、getaddrinfo が解決した
//      実 IP を検査するため回避されにくい。
//   3. fetch は redirect:'manual' とし、Location をたどるたびに再検査する
//      （最大リダイレクト回数を制限）。
//   4. タイムアウトとレスポンスサイズ上限を強制する。
//
// 既知の残存リスク: DNS rebinding。
//   本実装は「解決 → 検査」の後に fetch が改めて名前解決するため、
//   検査時と接続時で応答 IP が入れ替わる TOCTOU の窓が残る。完全な封鎖には
//   検査済み IP へ接続をピン留めするカスタム dispatcher(undici Agent の
//   connect.lookup 等)が必要だが、undici が直接依存に無いため本 PR では
//   採用していない。redirect:'manual' + 毎ホップ再検査 + タイムアウト +
//   サイズ上限で攻撃面を大幅に縮小している。詳細は PR 本文参照。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /** 全体タイムアウト(ms)。既定 10 秒。 */
  timeoutMs?: number;
  /** 追跡する最大リダイレクト回数。既定 5。 */
  maxRedirects?: number;
  /** 読み取り最大バイト数。既定 5MiB。 */
  maxBytes?: number;
  method?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** IPv4 文字列を 32bit 符号なし整数へ。標準ドット表記のみ受け付ける。 */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new SsrfBlockedError(`不正なIPv4: ${ip}`);
  let acc = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new SsrfBlockedError(`不正なIPv4: ${ip}`);
    }
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

/** IPv4 が非グローバル(ブロック対象)なら true。 */
function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: string, prefix: number): boolean => {
    const b = ipv4ToInt(base);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // 現在のネットワーク / unspecified
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local(169.254.169.254 metadata を含む)
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // ベンチマーク
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) || // reserved(255.255.255.255 broadcast を含む)
    false
  );
}

/** IPv6 文字列を 16 バイト配列へ展開。 */
function ipv6ToBytes(ip: string): number[] {
  // ゾーン ID(%eth0 等)を除去
  const addr = ip.split("%")[0]!;
  // IPv4-mapped / embedded (::ffff:1.2.3.4 など) を含む末尾 IPv4 を処理
  let head = addr;
  let tailV4: number[] | null = null;
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4int = ipv4ToInt(maybeV4);
    tailV4 = [(v4int >>> 24) & 0xff, (v4int >>> 16) & 0xff, (v4int >>> 8) & 0xff, v4int & 0xff];
    head = addr.slice(0, lastColon + 1) + "0:0";
  }

  const halves = head.split("::");
  if (halves.length > 2) throw new SsrfBlockedError(`不正なIPv6: ${ip}`);
  const expandGroups = (s: string): number[] => {
    if (s === "") return [];
    return s.split(":").map((g) => {
      const v = parseInt(g, 16);
      if (Number.isNaN(v) || v < 0 || v > 0xffff) {
        throw new SsrfBlockedError(`不正なIPv6: ${ip}`);
      }
      return v;
    });
  };
  const left = expandGroups(halves[0]!);
  const right = halves.length === 2 ? expandGroups(halves[1]!) : [];
  const fillCount = 8 - left.length - right.length;
  if (fillCount < 0 || (halves.length === 1 && fillCount !== 0)) {
    throw new SsrfBlockedError(`不正なIPv6: ${ip}`);
  }
  const groups = [...left, ...new Array(fillCount).fill(0), ...right];
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >>> 8) & 0xff, g & 0xff);
  }
  if (tailV4) {
    // 末尾 4 バイトを IPv4 で上書き
    bytes.splice(12, 4, ...tailV4);
  }
  if (bytes.length !== 16) throw new SsrfBlockedError(`不正なIPv6: ${ip}`);
  return bytes;
}

/** IPv6 が非グローバル(ブロック対象)なら true。 */
function isBlockedIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);

  // IPv4-mapped ::ffff:0:0/96 → 埋め込み IPv4 を IPv4 ルールで検査
  const isV4Mapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  // NAT64 well-known prefix 64:ff9b::/96 も同様に埋め込み IPv4 を検査
  const isNat64 =
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0);
  if (isV4Mapped || isNat64) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    return isBlockedIPv4(v4);
  }

  const isUnspecified = b.every((x) => x === 0); // ::
  const isLoopback = b.slice(0, 15).every((x) => x === 0) && b[15] === 1; // ::1
  const isMulticast = b[0] === 0xff; // ff00::/8
  const isLinkLocal = b[0] === 0xfe && (b[1]! & 0xc0) === 0x80; // fe80::/10
  const isSiteLocalDeprecated = b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0; // fec0::/10
  const isUniqueLocal = (b[0]! & 0xfe) === 0xfc; // fc00::/7 (ULA private)
  const isDoc = b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8; // 2001:db8::/32

  return (
    isUnspecified ||
    isLoopback ||
    isMulticast ||
    isLinkLocal ||
    isSiteLocalDeprecated ||
    isUniqueLocal ||
    isDoc
  );
}

/** 解決済み IP(または IP リテラル)が非グローバルならブロック。 */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIPv4(ip);
  if (fam === 6) return isBlockedIPv6(ip);
  // IP として解釈できない値は安全側でブロック
  return true;
}

/**
 * URL を検査し、取得を許可してよいかを判定する。
 * - スキーム http/https のみ
 * - 認証情報埋め込み(user:pass@)拒否
 * - ホスト名を DNS 解決し、全解決 IP を検査（1 つでも非グローバルなら拒否）
 * 問題があれば SsrfBlockedError を投げる。
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`URLとして解釈できません: ${rawUrl.slice(0, 100)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`許可されないスキームです: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new SsrfBlockedError("URL への認証情報埋め込みは許可されていません");
  }
  const host = u.hostname;
  if (!host) throw new SsrfBlockedError("ホスト名が空です");

  // ホストが IP リテラルならそのまま検査
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError(`アクセスが許可されない宛先です: ${host}`);
    }
    return;
  }

  // DNS 解決して全ての解決先を検査
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`ホスト名を解決できません: ${host}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError(`ホスト名を解決できません: ${host}`);
  }
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      throw new SsrfBlockedError(
        `アクセスが許可されない宛先です: ${host} -> ${a.address}`,
      );
    }
  }
}

/**
 * SSRF ガード付き fetch。リダイレクトを手動で追跡し、各ホップで
 * assertUrlAllowed を再実行する。タイムアウトとサイズ上限を強制。
 * 呼び出し側が本文を扱えるよう Response を返す(本文は maxBytes まで)。
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // eslint-disable-next-line no-await-in-loop
      await assertUrlAllowed(currentUrl);

      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(currentUrl, {
        method: options.method ?? "GET",
        headers: options.headers,
        redirect: "manual",
        signal: controller.signal,
      });

      // リダイレクトは手動追跡
      // 標準の fetch は必ず Response(headers 付き)を返す。ここで headers を
      // オプショナル参照するのは、テストが `fetch` を `{ text }` のような最小形状で
      // モックしても本ガードが落ちないようにするためだけであり(その場合 status も
      // undefined でこの分岐に入らない)、本番の防御(毎ホップ再検査)は不変。
      if (res.status >= 300 && res.status < 400 && res.headers?.has?.("location")) {
        const loc = res.headers.get("location")!;
        // 本文は破棄
        try {
          res.body?.cancel();
        } catch {
          /* noop */
        }
        if (hop >= maxRedirects) {
          throw new SsrfBlockedError("リダイレクト回数の上限を超えました");
        }
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }

      return enforceSize(res, maxBytes);
    }
    // ループを抜けることは無いが型のため
    throw new SsrfBlockedError("リダイレクト回数の上限を超えました");
  } finally {
    clearTimeout(timer);
  }
}

/** レスポンス本文サイズ上限を強制した Response を返す。 */
function enforceSize(res: Response, maxBytes: number): Response {
  // headers/body はオプショナル参照。本番の fetch は常に完全な Response を返すため
  // ここでの挙動は不変(content-length 事前検査＋ストリーム逐次サイズ上限)。
  // テストが `fetch` を最小形状(headers/body 無し)でモックした場合のみ、
  // 事前検査を飛ばして res をそのまま返し、呼び出し側の .text() を成立させる。
  const lenHeader = res.headers?.get?.("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    try {
      res.body?.cancel();
    } catch {
      /* noop */
    }
    throw new SsrfBlockedError(
      `レスポンスが大きすぎます: ${lenHeader} bytes (上限 ${maxBytes})`,
    );
  }
  if (!res.body) return res;

  const reader = res.body.getReader();
  let received = 0;
  const capped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        controller.error(
          new SsrfBlockedError(`レスポンスが大きすぎます(上限 ${maxBytes} bytes)`),
        );
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(capped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
