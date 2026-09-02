// GID 1216277595663810 派生棚卸し: super_adminプレビューmode中に成約・効果分析ページも
// テナントスコープされず全テナント横断データが表示されていた不具合の回帰テスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConversionDashboardPage from './index';
import { useAuth } from '../../../auth/useAuth';
import { authFetch } from '../../../lib/api';
import { createAuthMock } from '../../../test/authMock';

vi.mock('../../../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

// t() はキーをそのまま返すのではなく実辞書(ja.ts)を引く。
// キー名を返すだけのモックだと「間違ったキーを参照していても素通りする」ため、
// 画面に実際に出る日本語で検証できるようにする
// (KnowledgeListTab.test.tsx / escalations/[sessionId].test.tsx と同じ既存パターン)。
vi.mock('../../../i18n/LangContext', async () => {
  const jaModule = await import('../../../i18n/ja');
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string, vars?: Record<string, string | number>) => {
    let text = ja[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return text;
  };
  const stableValue = { lang: 'ja' as const, setLang: () => {}, t: stableT };
  return { useLang: () => stableValue };
});

vi.mock('../../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: vi.fn(),
}));

const SUPER_ADMIN_PREVIEWING = createAuthMock({
  user: { id: '1', email: 'admin@example.com', role: 'super_admin', tenantId: null, tenantName: null },
  isClientAdmin: true,
  previewMode: true,
  previewTenantId: 'lp-demo-avator',
  previewTenantName: 'LP Demo',
});

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function renderPage() {
  return render(
    <MemoryRouter>
      <ConversionDashboardPage />
    </MemoryRouter>,
  );
}

describe('ConversionDashboardPage — super_adminプレビューmodeのテナントスコープ', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({}));
  });

  it('プレビューmode中はpreviewTenantIdでtenant_idパラメータをリクエストに含める（修正前は空のuser.tenantIdでフィルタ無しになっていた）', async () => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING);
    renderPage();

    await waitFor(() => {
      const attrCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes('/v1/admin/conversion/attributions'),
      );
      expect(attrCall).toBeTruthy();
      expect(String(attrCall![0])).toContain('tenant_id=lp-demo-avator');

      const expCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes('/v1/admin/ab/experiments'),
      );
      expect(expCall).toBeTruthy();
      expect(String(expCall![0])).toContain('tenant_id=lp-demo-avator');
    });
  });
});

// プラン制限(403)を「読み込み失敗」「0件」と誤表示しない回帰テスト
// (2026-08-16 本番実機検証: starterプランのcarnationで /conversion/effectiveness が
//  403 plan_upgrade_required を返すのに画面は「合計成約数 0」を平然と表示していた)
const mockStatus = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);

describe('ConversionDashboardPage — プラン制限(403)の表示', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING);
    vi.mocked(authFetch).mockReset();
  });

  it('3本とも403 plan_upgrade_requiredのとき「0」を描画せず、プラン制限メッセージを出す(赤帯は出さない)', async () => {
    const PLAN_MSG = 'CV計測はGrowthプラン以上でご利用いただけます';
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      return mockStatus(403, { error: 'plan_upgrade_required', message: PLAN_MSG });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(PLAN_MSG))).toBeTruthy();
    });
    // 「合計成約数」のKPIカードに「0」という実データ風の値が出ていないこと
    expect(screen.queryByText('0')).toBeNull();
    // エラー赤帯(「読み込みに失敗しました」)は出ない — 403は正常系の分岐
    expect(screen.queryByText(/読み込みに失敗しました/)).toBeNull();
  });

  it('500など通常のエラーでは「読み込みに失敗しました」+再試行を出し、プラン制限メッセージは出さない', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      return mockStatus(500, { error: 'internal_error' });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/読み込みに失敗しました/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'やり直す' })).toBeTruthy();
    expect(screen.queryByText(/プランでご利用いただけます|プランのアップグレード/)).toBeNull();
  });

  it('一部だけ200・一部だけ403でも、200で取得できたデータは表示される(並列取得の分離)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      if (u.includes('/v1/admin/conversion/attributions')) {
        return mockStatus(200, { summary: { total: 7, by_type: {}, by_principle: {}, avg_temp_score: 42 } });
      }
      return mockStatus(403, { error: 'plan_upgrade_required', message: 'Growthプラン以上でご利用いただけます' });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('7')).toBeTruthy();
    });
  });
});

// 改善提案セクションが常に空表示になっていた回帰テスト
// (実装が /v1/admin/notifications のレスポンスキー `items` ではなく存在しない `notifications`
//  を読んでいたため、実際に未読の auto_tuning_suggestion があってもUIには一切出ていなかった)
describe('ConversionDashboardPage — 改善提案セクション', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING);
    vi.mocked(authFetch).mockReset();
  });

  it('/v1/admin/notifications が items で返す未読提案を描画する', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) {
        return mockStatus(200, {
          items: [
            {
              id: 1,
              type: 'auto_tuning_suggestion',
              message: '同じ質問が繰り返されています',
              metadata: { suggested_action: '送料に関するFAQを追加する', candidate_type: 'judge_repeated' },
            },
          ],
          unread_count: 1,
          total: 1,
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('同じ質問が繰り返されています')).toBeTruthy();
      expect(screen.getByText(/送料に関するFAQを追加する/)).toBeTruthy();
    });
  });

  // ポーリング側(この画面)と通知を作る側(src/api/conversion/autoTuning.ts の
  // runAutoTuningCheck)の type/is_read の文字列が食い違うと、通知は作られているのに
  // 画面には一切出ない(=今回直った不具合そのもの)。クエリ文字列を固定して再発を防ぐ。
  it('type=auto_tuning_suggestion & is_read=false でポーリングする(通知を作る側のtypeと一致させる契約)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      const call = vi.mocked(authFetch).mock.calls.find(([url]) => String(url).includes('/v1/admin/notifications'));
      expect(call).toBeTruthy();
      expect(String(call![0])).toContain('type=auto_tuning_suggestion');
      expect(String(call![0])).toContain('is_read=false');
    });
  });

  // 🏆バッジは metadata.candidate_type === 'ab_winner' のときだけ出る想定
  // (judge_repeated=🔁, それ以外=⭐)。ab_winner以外にも🏆が出てしまう/
  // ab_winnerで🏆が出ない、のどちらの回帰も検知する。
  it('🏆バッジは candidate_type==="ab_winner" の提案にだけ出る', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) {
        return mockStatus(200, {
          items: [
            {
              id: 1,
              type: 'auto_tuning_suggestion',
              message: 'A/Bテスト「CTA文言テスト」でVariant Bが勝利',
              metadata: { suggested_action: 'Variant Bを適用', candidate_type: 'ab_winner' },
            },
            {
              id: 2,
              type: 'auto_tuning_suggestion',
              message: '同じ質問が繰り返されています',
              metadata: { suggested_action: '送料に関するFAQを追加する', candidate_type: 'judge_repeated' },
            },
            {
              id: 3,
              type: 'auto_tuning_suggestion',
              message: '「返報性」が5回のCVに貢献',
              metadata: { suggested_action: '「返報性」を優先設定', candidate_type: 'effectiveness_top' },
            },
          ],
          unread_count: 3,
          total: 3,
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('A/Bテスト「CTA文言テスト」でVariant Bが勝利')).toBeTruthy();
    });
    expect(screen.getAllByText('🏆')).toHaveLength(1);
    expect(screen.getAllByText('🔁')).toHaveLength(1);
    expect(screen.getAllByText('⭐')).toHaveLength(1);
  });
});

// 母数不足の間、「データがありません」で機能が壊れて見えないようにする回帰テスト
// (Growth顧客が初週に開くと効果ランキング・A/Bの3枚とも空表示になっていた実害への対処)。
describe('ConversionDashboardPage — 母数不足時の到達条件表示', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING);
    vi.mocked(authFetch).mockReset();
  });

  it('実験が1件も無いときは「まだ作成されていません」を出す(実施中0件と区別する)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      if (u.includes('/v1/admin/ab/experiments')) return mockStatus(200, { experiments: [] });
      if (u.includes('/v1/admin/conversion/attributions')) {
        return mockStatus(200, { summary: { total: 0, by_type: {}, by_principle: {}, avg_temp_score: 0 } });
      }
      return mockStatus(200, { rankings: [] });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('まだA/Bテストが作成されていません。')).toBeTruthy();
    });
  });

  it('実施中の実験がサンプル不足のとき、現在数と必要数を出す(勝敗は出さない)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      if (u.includes('/v1/admin/ab/experiments')) {
        return mockStatus(200, {
          experiments: [
            {
              id: 1,
              name: '挨拶パターンA/B',
              status: 'running',
              traffic_split: 0.5,
              min_sample_size: 100,
              total_exposed: 12,
              created_at: '2026-08-01T00:00:00Z',
            },
          ],
        });
      }
      if (u.includes('/v1/admin/conversion/attributions')) {
        return mockStatus(200, { summary: { total: 0, by_type: {}, by_principle: {}, avg_temp_score: 0 } });
      }
      return mockStatus(200, { rankings: [] });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('サンプル収集中（12 / 100件）')).toBeTruthy();
    });
    expect(screen.queryByText(/判定に十分なサンプル/)).toBeNull();
  });

  it('成約がまだ無いときの効果ランキングは、成約が無い旨を出す(検索原因を混同しない)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { items: [] });
      if (u.includes('/v1/admin/ab/experiments')) return mockStatus(200, { experiments: [] });
      if (u.includes('/v1/admin/conversion/attributions')) {
        return mockStatus(200, { summary: { total: 0, by_type: {}, by_principle: {}, avg_temp_score: 0 } });
      }
      return mockStatus(200, { rankings: [] });
    });

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText('まだコンバージョンが記録されていません。接客が成約に繋がると、ここに効果の高いアプローチが表示されます。'),
      ).toBeTruthy();
    });
  });
});
