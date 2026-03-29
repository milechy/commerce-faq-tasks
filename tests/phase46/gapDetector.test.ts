// tests/phase46/gapDetector.test.ts
// Phase46: Knowledge Gap Detector unit tests

// jest.mock is hoisted — define mock state via module-level vars accessible by the factory
const mockQuery = jest.fn();
const mockPool = { query: mockQuery };

jest.mock('../../src/lib/db', () => ({
  getPool: () => mockPool,
}));

// Import after mocking
import { detectGap } from '../../src/agent/gap/gapDetector';

const BASE_INPUT = {
  tenantId: 'tenant-abc',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  userMessage: 'How do I return a product?',
  ragResultCount: 3,
};

describe('gapDetector', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    delete process.env['GAP_DETECTION_ENABLED'];
    delete process.env['GAP_CONFIDENCE_THRESHOLD'];
    delete process.env['JUDGE_SCORE_THRESHOLD'];
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Test 1: no_rag trigger
  it('detects gap with source=no_rag when ragResultCount === 0', async () => {
    // No existing gap found
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT returns new id
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const result = await detectGap({ ...BASE_INPUT, ragResultCount: 0 });

    expect(result.detected).toBe(true);
    expect(result.source).toBe('no_rag');
    expect(result.gapId).toBe(1);
  });

  // Test 2: low_confidence trigger
  it('detects gap with source=low_confidence when topRerankScore < 0.3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const result = await detectGap({ ...BASE_INPUT, ragResultCount: 2, topRerankScore: 0.1 });

    expect(result.detected).toBe(true);
    expect(result.source).toBe('low_confidence');
    expect(result.gapId).toBe(2);
  });

  // Test 3: fallback trigger
  it('detects gap with source=fallback when templateSource === "fallback"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });

    const result = await detectGap({
      ...BASE_INPUT,
      ragResultCount: 1,
      topRerankScore: 0.8,
      templateSource: 'fallback',
    });

    expect(result.detected).toBe(true);
    expect(result.source).toBe('fallback');
  });

  // Test 4: judge_low trigger
  it('detects gap with source=judge_low when judgeScore < 60', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 4 }] });

    const result = await detectGap({
      ...BASE_INPUT,
      ragResultCount: 2,
      topRerankScore: 0.9,
      judgeScore: 45,
    });

    expect(result.detected).toBe(true);
    expect(result.source).toBe('judge_low');
  });

  // Test 5: No trigger fires when conditions are normal
  it('returns detected=false when all conditions are normal', async () => {
    const result = await detectGap({
      ...BASE_INPUT,
      ragResultCount: 3,
      topRerankScore: 0.8,
      templateSource: 'notion',
      judgeScore: 80,
    });

    expect(result.detected).toBe(false);
    expect(result.source).toBeNull();
    // No DB queries should have been called
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Test 6: Existing gap found → increments frequency (UPDATE called)
  it('increments frequency when existing gap found', async () => {
    // SELECT finds existing gap with id=10
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }] });
    // UPDATE succeeds
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await detectGap({ ...BASE_INPUT, ragResultCount: 0 });

    expect(result.detected).toBe(true);
    expect(result.source).toBe('no_rag');
    expect(result.gapId).toBe(10);

    // Second call should be UPDATE
    const updateCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(updateCall[0]).toContain('UPDATE knowledge_gaps');
    expect(updateCall[0]).toContain('frequency = COALESCE(frequency, 1) + 1');
    expect(updateCall[1]).toContain(10);
  });

  // Test 7: New gap inserted (no existing) → INSERT called
  it('inserts new gap when no existing gap found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] });

    const result = await detectGap({ ...BASE_INPUT, ragResultCount: 0 });

    expect(result.gapId).toBe(99);
    // Second call should be INSERT
    const insertCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(insertCall[0]).toContain('INSERT INTO knowledge_gaps');
    expect(insertCall[0]).toContain('RETURNING id');
  });

  // Test 8: DB failure → returns { detected: false, source: null }, no throw
  it('returns { detected: false, source: null } on DB failure without throwing', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection error'));

    const result = await detectGap({ ...BASE_INPUT, ragResultCount: 0 });

    expect(result.detected).toBe(false);
    expect(result.source).toBeNull();
    expect(result.gapId).toBeUndefined();
  });

  // Test 9: GAP_DETECTION_ENABLED=false → returns { detected: false } immediately
  it('returns { detected: false } immediately when GAP_DETECTION_ENABLED=false', async () => {
    process.env['GAP_DETECTION_ENABLED'] = 'false';

    const result = await detectGap({ ...BASE_INPUT, ragResultCount: 0 });

    expect(result.detected).toBe(false);
    expect(result.source).toBeNull();
    // No DB queries should have been called
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Test 10: userMessage truncated to 200 chars
  it('truncates userMessage to 200 chars before storing', async () => {
    const longMessage = 'A'.repeat(300);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }] });

    await detectGap({ ...BASE_INPUT, ragResultCount: 0, userMessage: longMessage });

    // The INSERT call should have the truncated message (200 chars)
    const insertCall = mockQuery.mock.calls[1] as [string, unknown[]];
    const storedQuestion = insertCall[1][1] as string;
    expect(storedQuestion).toHaveLength(200);
    expect(storedQuestion).toBe('A'.repeat(200));
  });
});
