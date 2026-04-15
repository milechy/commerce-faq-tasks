// admin-ui/src/lib/buildAvatarPrompt.test.ts

import { describe, it, expect } from 'vitest';
import { buildAvatarPrompt } from './buildAvatarPrompt';

describe('buildAvatarPrompt', () => {
  describe('human type', () => {
    it('女性・30代・スーツ・胸上・笑顔・オフィス', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'human',
        gender: 'female',
        age: '30s',
        outfit: 'business_suit',
        composition: 'bust',
        expression: 'smile',
        background: 'office',
      });
      expect(prompt).toContain('Japanese woman');
      expect(prompt).toContain('30s');
      expect(prompt).toContain('business suit');
      expect(prompt).toContain('bust shot');
      expect(prompt).toContain('smile');
      expect(prompt).toContain('office');
    });

    it('男性・40代・白衣・全身・真剣・シンプル', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'human',
        gender: 'male',
        age: '40s',
        outfit: 'white_coat',
        composition: 'full_body',
        expression: 'serious',
        background: 'simple',
      });
      expect(prompt).toContain('Japanese man');
      expect(prompt).toContain('40s');
      expect(prompt).toContain('white lab coat');
      expect(prompt).toContain('full body');
      expect(prompt).toContain('serious');
      expect(prompt).toContain('gray studio');
    });

    it('性別なし・年代なし（省略可）', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'human',
        composition: 'bust',
        expression: 'gentle',
        background: 'cafe',
      });
      expect(prompt).toContain('Japanese person');
      expect(prompt).toContain('cafe');
    });
  });

  describe('anime type', () => {
    it('女性アニメキャラ', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'anime',
        gender: 'female',
        composition: 'bust',
        expression: 'smile',
        background: 'simple',
      });
      expect(prompt).toContain('anime character illustration');
      expect(prompt).toContain('woman');
      expect(prompt).toContain('cel-shaded');
    });
  });

  describe('3d type', () => {
    it('3Dキャラ（男性）', () => {
      const { prompt } = buildAvatarPrompt({
        type: '3d',
        gender: 'male',
        composition: 'half_body',
        expression: 'cool',
        background: 'office',
      });
      expect(prompt).toContain('3D rendered character');
      expect(prompt).toContain('Pixar');
      expect(prompt).toContain('man');
    });
  });

  describe('animal type', () => {
    it('可愛い犬キャラ', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'animal',
        animalKind: 'dog',
        animalVibe: 'cute',
        composition: 'bust',
        expression: 'smile',
        background: 'cafe',
      });
      expect(prompt).toContain('anthropomorphic animal character');
      expect(prompt).toContain('dog');
      expect(prompt).toContain('cute');
      expect(prompt).toContain('business attire');
    });

    it('クールな狐キャラ', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'animal',
        animalKind: 'fox',
        animalVibe: 'cool',
        composition: 'half_body',
        expression: 'cool',
        background: 'simple',
      });
      expect(prompt).toContain('fox');
      expect(prompt).toContain('cool');
    });
  });

  describe('robot type', () => {
    it('SF系ロボット', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'robot',
        robotDesign: 'scifi',
        composition: 'bust',
        expression: 'serious',
        background: 'simple',
      });
      expect(prompt).toContain('robot character');
      expect(prompt).toContain('sci-fi android');
    });

    it('可愛いロボット', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'robot',
        robotDesign: 'cute',
        composition: 'full_body',
        expression: 'smile',
        background: 'office',
      });
      expect(prompt).toContain('cute friendly round robot');
    });
  });

  describe('カスタム背景', () => {
    it('カスタムカラー背景が含まれる', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'human',
        gender: 'female',
        composition: 'bust',
        expression: 'smile',
        background: 'custom',
        customBgColor: '#3b82f6',
      });
      expect(prompt).toContain('#3b82f6');
    });
  });

  describe('ネガティブプロンプト', () => {
    it('全タイプでネガティブプロンプトを返す', () => {
      for (const type of ['human', 'anime', '3d', 'animal', 'robot'] as const) {
        const { negativePrompt } = buildAvatarPrompt({
          type,
          composition: 'bust',
          expression: 'smile',
          background: 'simple',
        });
        expect(negativePrompt).toContain('blurry');
        expect(negativePrompt).toContain('nsfw');
      }
    });
  });

  describe('quality suffix', () => {
    it('全タイプに品質サフィックスが含まれる', () => {
      const { prompt } = buildAvatarPrompt({
        type: 'human',
        gender: 'female',
        composition: 'bust',
        expression: 'smile',
        background: 'simple',
      });
      expect(prompt).toContain('high quality');
      expect(prompt).toContain('8k resolution');
    });
  });
});
