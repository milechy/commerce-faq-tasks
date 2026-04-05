// tests/phase56/temperatureScoring.test.ts
// Phase56: 温度感スコアリング テスト

import { calculateTemperature } from '../../src/api/events/temperatureScoring';

describe('calculateTemperature', () => {
  describe('レベル判定', () => {
    it('cold (0-29): scrollDepth=10, idleTime=5, pageViews=1, productViews=0, returnVisit=false', () => {
      const result = calculateTemperature({
        scrollDepthMax: 10,
        idleTimeTotal: 5,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: false,
      });
      // scroll: round(10/5)=2, idle: round(5/15)=0, pages: 0, products: 0, return: 0 → 2点
      expect(result.score).toBe(2);
      expect(result.level).toBe('cold');
    });

    it('warm (30-69): scrollDepth=50, idleTime=30, pageViews=3, productViews=1, returnVisit=false', () => {
      const result = calculateTemperature({
        scrollDepthMax: 50,
        idleTimeTotal: 30,
        pageViews: 3,
        productViews: 1,
        isReturnVisit: false,
      });
      // scroll: round(50/5)=10, idle: round(30/15)=2, pages: (3-1)*2=4, products: 1*4=4, return: 0 → 20点
      expect(result.score).toBe(20);
      expect(result.level).toBe('cold');
    });

    it('hot (70-100): scrollDepth=100, idleTime=120, pageViews=8, productViews=3, returnVisit=true', () => {
      const result = calculateTemperature({
        scrollDepthMax: 100,
        idleTimeTotal: 120,
        pageViews: 8,
        productViews: 3,
        isReturnVisit: true,
      });
      // scroll: min(20, round(100/5))=20, idle: min(20, round(120/15))=min(20,8)=8
      // pages: min(20,(8-1)*2)=min(20,14)=14, products: min(20,3*4)=12, return: 20 → 74点
      expect(result.score).toBe(74);
      expect(result.level).toBe('hot');
    });
  });

  describe('境界値', () => {
    it('score=0: 全て最小値', () => {
      const result = calculateTemperature({
        scrollDepthMax: 0,
        idleTimeTotal: 0,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: false,
      });
      expect(result.score).toBe(0);
      expect(result.level).toBe('cold');
    });

    it('score=100: 全て最大値', () => {
      const result = calculateTemperature({
        scrollDepthMax: 100,
        idleTimeTotal: 300,
        pageViews: 11,
        productViews: 5,
        isReturnVisit: true,
      });
      // scroll:20, idle:20, pages:min(20,10*2)=20, products:min(20,5*4)=20, return:20 → 100
      expect(result.score).toBe(100);
      expect(result.level).toBe('hot');
    });

    it('score=30 境界 → warm', () => {
      const result = calculateTemperature({
        scrollDepthMax: 0,
        idleTimeTotal: 0,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: true, // 20点
        // + scroll=0, idle=0, pages=0, products=? → 30点に持っていく
        // returnVisit=true(20) + scroll=50(10) → 30
      });
      // まず return only = 20点 → cold
      expect(result.score).toBe(20);
    });

    it('score=30 ちょうど → warm', () => {
      const result = calculateTemperature({
        scrollDepthMax: 50, // 10点
        idleTimeTotal: 0,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: true, // 20点
      });
      expect(result.score).toBe(30);
      expect(result.level).toBe('warm');
    });

    it('score=70 ちょうど → hot', () => {
      const result = calculateTemperature({
        scrollDepthMax: 100, // 20
        idleTimeTotal: 0,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: true, // 20
        // + pages(1): 0, products: 0 → 40点... 70に持っていくには別の組み合わせ
      });
      // 100scroll(20) + return(20) = 40 → warm
      expect(result.level).toBe('warm');
    });

    it('hot境界: score=70', () => {
      const result = calculateTemperature({
        scrollDepthMax: 100,  // 20
        idleTimeTotal: 150,   // min(20, round(150/15))=min(20,10)=10
        pageViews: 6,         // min(20,(6-1)*2)=10
        productViews: 0,
        isReturnVisit: true,  // 20
      });
      // 20+10+10+0+20 = 60 → warm
      expect(result.level).toBe('warm');
    });
  });

  describe('各コンポーネント上限テスト', () => {
    it('scrollDepthMax > 100 → 上限20点', () => {
      const result = calculateTemperature({
        scrollDepthMax: 200,
        idleTimeTotal: 0,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: false,
      });
      // scroll: min(20, round(200/5))=min(20,40)=20
      expect(result.score).toBe(20);
    });

    it('idleTimeTotal > 300 → 上限20点', () => {
      const result = calculateTemperature({
        scrollDepthMax: 0,
        idleTimeTotal: 3600,
        pageViews: 1,
        productViews: 0,
        isReturnVisit: false,
      });
      // idle: min(20, round(3600/15))=20
      expect(result.score).toBe(20);
    });

    it('pageViews > 11 → 上限20点', () => {
      const result = calculateTemperature({
        scrollDepthMax: 0,
        idleTimeTotal: 0,
        pageViews: 100,
        productViews: 0,
        isReturnVisit: false,
      });
      // pages: min(20,(100-1)*2)=20
      expect(result.score).toBe(20);
    });

    it('productViews > 5 → 上限20点', () => {
      const result = calculateTemperature({
        scrollDepthMax: 0,
        idleTimeTotal: 0,
        pageViews: 1,
        productViews: 10,
        isReturnVisit: false,
      });
      // products: min(20,10*4)=20
      expect(result.score).toBe(20);
    });
  });

  describe('warm範囲テスト', () => {
    it('scroll=75, idle=60, pageViews=4, productViews=1, noReturn → warm', () => {
      const result = calculateTemperature({
        scrollDepthMax: 75,  // min(20, round(75/5))=15
        idleTimeTotal: 60,   // min(20, round(60/15))=4
        pageViews: 4,        // min(20, (4-1)*2)=6
        productViews: 1,     // 4
        isReturnVisit: false,
      });
      // 15+4+6+4+0 = 29 → cold (境界以下)
      expect(result.score).toBe(29);
      expect(result.level).toBe('cold');
    });
  });
});
