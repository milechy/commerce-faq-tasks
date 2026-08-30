// src/lib/net/ssrfGuard.test.ts
import { lookup } from "node:dns/promises";
import {
  isBlockedIp,
  assertUrlAllowed,
  safeFetch,
  SsrfBlockedError,
} from "./ssrfGuard";

jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(),
}));

const mockedLookup = lookup as unknown as jest.Mock;

/** lookup(host, {all:true}) の戻り値を模す */
function resolveTo(...ips: string[]) {
  mockedLookup.mockResolvedValue(
    ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
}

describe("isBlockedIp (IPv4)", () => {
  it.each([
    "169.254.169.254", // metadata
    "169.254.0.1", // link-local
    "127.0.0.1", // loopback
    "10.0.0.5", // private
    "172.16.0.1", // private
    "172.31.255.255", // private
    "192.168.1.1", // private
    "100.64.0.1", // CGNAT
    "0.0.0.0", // unspecified
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast/reserved
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("isBlockedIp (IPv6)", () => {
  it.each([
    "::1", // loopback
    "::", // unspecified
    "fe80::1", // link-local
    "fc00::1", // ULA
    "fd12:3456::1", // ULA
    "ff02::1", // multicast
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "64:ff9b::7f00:1", // NAT64 embedding 127.0.0.1
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("assertUrlAllowed", () => {
  beforeEach(() => mockedLookup.mockReset());

  it("rejects non-http scheme", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertUrlAllowed("gopher://x/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertUrlAllowed("http://user:pass@example.com/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects IP-literal metadata host without DNS", async () => {
    await expect(
      assertUrlAllowed("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("rejects when hostname resolves to loopback (DNS rebinding-style)", async () => {
    resolveTo("127.0.0.1");
    await expect(
      assertUrlAllowed("http://evil.example.com/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects when hostname resolves to private IP", async () => {
    resolveTo("10.1.2.3");
    await expect(assertUrlAllowed("http://intranet.test/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects if ANY resolved address is internal", async () => {
    resolveTo("93.184.216.34", "169.254.169.254");
    await expect(assertUrlAllowed("http://mixed.example.com/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("allows a public host", async () => {
    resolveTo("93.184.216.34");
    await expect(assertUrlAllowed("https://example.com/page")).resolves.toBeUndefined();
  });
});

describe("safeFetch redirect handling", () => {
  const realFetch = global.fetch;
  beforeEach(() => mockedLookup.mockReset());
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function redirectResponse(location: string): Response {
    return new Response(null, {
      status: 302,
      headers: { location },
    });
  }

  it("blocks a redirect that points to an internal IP", async () => {
    // 公開ホストは解決OK。だがリダイレクト先の IP リテラルは metadata。
    resolveTo("93.184.216.34");
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse("http://169.254.169.254/latest/"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(safeFetch("https://example.com/start")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    // 初回(公開)は fetch 実行、リダイレクト先はガードで弾かれ fetch されない
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public host and returns body", async () => {
    resolveTo("93.184.216.34");
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://example.org/final"))
      .mockResolvedValueOnce(new Response("hello", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await safeFetch("https://example.com/start");
    await expect(res.text()).resolves.toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts when redirects exceed the limit", async () => {
    resolveTo("93.184.216.34");
    const fetchMock = jest
      .fn()
      .mockResolvedValue(redirectResponse("https://example.com/loop"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      safeFetch("https://example.com/start", { maxRedirects: 2 }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
