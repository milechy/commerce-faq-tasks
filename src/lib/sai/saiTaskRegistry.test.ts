// src/lib/sai/saiTaskRegistry.test.ts
// Sai代行タスク所有権レジストリの単体テスト。
// 「不存在」「照合不能(migration未適用)」「越境」を別々に固定する。

import type { Pool } from 'pg';
import { recordSaiTask, resolveSaiTaskTenant } from './saiTaskRegistry';

function makePool(impl: (sql: string, params?: unknown[]) => unknown): Pool {
  return { query: jest.fn(impl as any) } as unknown as Pool;
}

function pgError(code: string): Error & { code: string } {
  const err = new Error(`pg error ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('saiTaskRegistry', () => {
  describe('recordSaiTask', () => {
    it('task_id・tenant_id・依頼内容を記録し true を返す', async () => {
      const pool = makePool(() => ({ rows: [], rowCount: 1 }));

      const ok = await recordSaiTask(pool, {
        taskId: 'task-1',
        tenantId: 'tenant-a',
        description: '送料表記を直して',
        requestedBy: 'admin@example.com',
      });

      expect(ok).toBe(true);
      const [sql, params] = (pool.query as jest.Mock).mock.calls[0];
      expect(sql).toContain('INSERT INTO sai_tasks');
      expect(params).toEqual(['task-1', 'tenant-a', null, '送料表記を直して', 'admin@example.com']);
    });

    it('option_orders 経由は order_id を保持する', async () => {
      const pool = makePool(() => ({ rows: [], rowCount: 1 }));

      await recordSaiTask(pool, {
        taskId: 'task-2',
        tenantId: 'tenant-a',
        description: 'FAQ登録代行',
        orderId: 'order-9',
      });

      const [, params] = (pool.query as jest.Mock).mock.calls[0];
      expect(params[2]).toBe('order-9');
      expect(params[4]).toBeNull();
    });

    it('sai_tasks 未マイグレーション(42P01)でも例外を投げず false を返す', async () => {
      const pool = makePool(() => { throw pgError('42P01'); });

      await expect(
        recordSaiTask(pool, { taskId: 't', tenantId: 'tenant-a', description: 'x' }),
      ).resolves.toBe(false);
    });

    it('DB障害でも例外を投げず false を返す（依頼はVPS側で進行済みのため）', async () => {
      const pool = makePool(() => { throw pgError('08006'); });

      await expect(
        recordSaiTask(pool, { taskId: 't', tenantId: 'tenant-a', description: 'x' }),
      ).resolves.toBe(false);
    });
  });

  describe('resolveSaiTaskTenant', () => {
    it('記録があれば ok と依頼元テナントを返す', async () => {
      const pool = makePool(() => ({ rows: [{ tenant_id: 'tenant-a' }], rowCount: 1 }));

      await expect(resolveSaiTaskTenant(pool, 'task-1')).resolves.toEqual({
        status: 'ok',
        tenantId: 'tenant-a',
      });
    });

    it('記録が無ければ not_found を返す（unavailable と区別する）', async () => {
      const pool = makePool(() => ({ rows: [], rowCount: 0 }));

      await expect(resolveSaiTaskTenant(pool, 'task-x')).resolves.toEqual({ status: 'not_found' });
    });

    it('sai_tasks 未マイグレーション(42P01)は unavailable を返す（fail-closed、not_found に丸めない）', async () => {
      const pool = makePool(() => { throw pgError('42P01'); });

      await expect(resolveSaiTaskTenant(pool, 'task-1')).resolves.toEqual({ status: 'unavailable' });
    });

    it('DB障害も unavailable を返す（照合できない＝許可しない）', async () => {
      const pool = makePool(() => { throw pgError('08006'); });

      await expect(resolveSaiTaskTenant(pool, 'task-1')).resolves.toEqual({ status: 'unavailable' });
    });
  });
});
