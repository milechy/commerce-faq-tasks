// admin-ui/src/pages/admin/billing/margin/UpsellProposalsSection.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { UpsellProposalsSection } from './UpsellProposalsSection';

const mockAuthFetch = vi.fn();
vi.mock('../../../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const PROPOSAL = {
  proposal_id: '1', tenant_id: 't1', renderable: true,
  headline: 'アップセル候補',
  lines: ['粗利 ¥20,800（粗利率 93.3%）', '月額基本料: ¥9,800 → ¥29,800'],
  created_at: '2026-09-04T00:00:00Z',
};

beforeEach(() => vi.clearAllMocks());

describe('UpsellProposalsSection', () => {
  it('提案があれば見出しと本文、採用/見送りボタンを描画する', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [PROPOSAL] }));
    render(<UpsellProposalsSection />);
    expect(await screen.findByText('アップセル候補')).toBeTruthy();
    expect(screen.getByText(/粗利 ¥20,800/)).toBeTruthy();
    expect(screen.getByText('営業案として採用')).toBeTruthy();
    expect(screen.getByText('見送り')).toBeTruthy();
  });

  it('★ラベルは「承認」ではない(FAQチューニングの承認と混同させない)★', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [PROPOSAL] }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');
    expect(screen.queryByText('承認')).toBeNull();
  });

  it('★「AIの応答ルールは変わりません」の注記が常時出る★', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [PROPOSAL] }));
    render(<UpsellProposalsSection />);
    expect(await screen.findByText(/AI の応答ルールは変わりません/)).toBeTruthy();
  });

  it('提案が0件なら何も描画しない(セクション自体が消える)', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [] }));
    const { container } = render(<UpsellProposalsSection />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('取得失敗時は何も描画しない(粗利表は成立する。fail-silent)', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(500, {}));
    const { container } = render(<UpsellProposalsSection />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('★「採用」を押すと adopt エンドポイントを叩き、一覧から消える★', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [PROPOSAL] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');

    fireEvent.click(screen.getByText('営業案として採用'));

    await waitFor(() => {
      const call = mockAuthFetch.mock.calls[1]!;
      expect(call[0]).toBe('http://localhost:3100/v1/admin/upsell-proposals/1/adopt');
      expect(call[1]).toMatchObject({ method: 'PUT' });
    });
    await waitFor(() => expect(screen.queryByText('アップセル候補')).toBeNull());
  });

  it('「見送り」を押すと dismiss エンドポイントを叩く(URLがadoptと異なる)', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [PROPOSAL] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');

    fireEvent.click(screen.getByText('見送り'));

    await waitFor(() => {
      const call = mockAuthFetch.mock.calls[1]!;
      expect(call[0]).toBe('http://localhost:3100/v1/admin/upsell-proposals/1/dismiss');
    });
  });

  it('操作失敗時はトーストで失敗を伝え、一覧からは消さない(再試行可能)', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [PROPOSAL] }))
      .mockResolvedValueOnce(jsonResponse(500, {}));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');

    fireEvent.click(screen.getByText('営業案として採用'));

    expect(await screen.findByText(/操作に失敗しました/)).toBeTruthy();
    expect(screen.getByText('アップセル候補')).toBeTruthy();
  });

  it('★ボタンの二重クリック(連打)でも同一提案への操作は1回目の完了まで無効化される★', async () => {
    let resolveFn: ((v: unknown) => void) | undefined;
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [PROPOSAL] }))
      .mockImplementationOnce(() => new Promise((r) => { resolveFn = r; }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');

    const btn = screen.getByText('営業案として採用') as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn); // 2発目は無効化されているのでクリックしても何も起きない

    expect(mockAuthFetch.mock.calls.length).toBe(2); // 一覧取得1回 + adopt1回のみ
    resolveFn!(jsonResponse(200, { ok: true }));
  });

  it('renderable:false の行はフォールバック文言を出し、クラッシュしない', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      proposals: [{ proposal_id: '9', tenant_id: 't9', renderable: false, created_at: 'x' }],
    }));
    render(<UpsellProposalsSection />);
    expect(await screen.findByText(/t9/)).toBeTruthy();
  });

  it('★headline/lines に <script> が混ざっても実行可能なDOMとして解釈されない(XSS耐性)★', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      proposals: [{
        ...PROPOSAL,
        headline: '<script>window.__xss_upsell = true</script>アップセル候補',
        lines: ['<img src=x onerror="window.__xss_upsell2=true">超過中'],
      }],
    }));
    const { container } = render(<UpsellProposalsSection />);
    await waitFor(() => expect(container.querySelector('button')).toBeTruthy());
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss_upsell?: boolean }).__xss_upsell).toBeUndefined();
  });

  it('★truncated:true のとき上限に達した旨を表示する(P1a: 黙って一部だけ返さない)★', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [PROPOSAL], truncated: true }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');
    expect(screen.getByText(/上限に達しています/)).toBeTruthy();
  });

  it('truncated:false(既定)のときは上限メッセージを出さない', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [PROPOSAL] }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');
    expect(screen.queryByText(/上限に達しています/)).toBeNull();
  });

  it('複数提案が同時に表示され、片方だけ操作しても他方に影響しない', async () => {
    const p2 = { ...PROPOSAL, proposal_id: '2', tenant_id: 't2', headline: '提案B' };
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(200, { proposals: [PROPOSAL, p2] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    render(<UpsellProposalsSection />);
    await screen.findByText('提案B');

    const buttons = screen.getAllByText('営業案として採用');
    fireEvent.click(buttons[0]!);

    await waitFor(() => expect(screen.queryByText('アップセル候補')).toBeNull());
    expect(screen.getByText('提案B')).toBeTruthy();
  });

  it('★stale:true のとき作成月と警告バッジを表示する(P2b: 長期pendingの陳腐化を黙って隠さない)★', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      proposals: [{ ...PROPOSAL, period_yyyymm: '202609', stale: true }],
    }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');
    expect(screen.getByText(/作成月: 202609/)).toBeTruthy();
    expect(screen.getByText(/今月の状況と異なる可能性があります/)).toBeTruthy();
  });

  it('stale:false のときは作成月だけ表示し、警告バッジは出さない', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      proposals: [{ ...PROPOSAL, period_yyyymm: '202609', stale: false }],
    }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');
    expect(screen.getByText(/作成月: 202609/)).toBeTruthy();
    expect(screen.queryByText(/今月の状況と異なる可能性があります/)).toBeNull();
  });

  it('period_yyyymm が無ければ作成月の行自体を出さない(evidence が壊れている旧データ)', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { proposals: [PROPOSAL] }));
    render(<UpsellProposalsSection />);
    await screen.findByText('アップセル候補');
    expect(screen.queryByText(/作成月:/)).toBeNull();
  });
});
