// admin-ui/src/lib/buildAvatarPrompt.ts
// Phase64 タスク4: 選択肢の組み合わせからFlux 2プロンプトを自動組み立てる

export type AvatarType = 'human' | 'anime' | '3d' | 'animal' | 'robot';
export type Gender = 'male' | 'female';
export type AgeRange = '20s' | '30s' | '40s' | '50s+';
export type Outfit = 'business_suit' | 'casual' | 'white_coat' | 'uniform';
export type AnimalKind = 'dog' | 'cat' | 'bird' | 'bear' | 'fox' | 'other';
export type AnimalVibe = 'cute' | 'cool' | 'silly';
export type RobotDesign = 'simple' | 'mecha' | 'scifi' | 'cute';
export type Composition = 'face_close' | 'bust' | 'half_body' | 'full_body';
export type Expression = 'smile' | 'serious' | 'cool' | 'gentle';
export type Background = 'simple' | 'office' | 'cafe' | 'custom';

export interface AvatarPromptInput {
  type: AvatarType;
  // human
  gender?: Gender;
  age?: AgeRange;
  outfit?: Outfit;
  // animal
  animalKind?: AnimalKind;
  animalVibe?: AnimalVibe;
  // robot / 3d / anime
  robotDesign?: RobotDesign;
  // common
  composition: Composition;
  expression: Expression;
  background: Background;
  customBgColor?: string;
}

// ── パーツマッピング ──────────────────────────────────────────────────────────

const SUBJECT: Record<AvatarType, string> = {
  human:  'professional portrait photograph',
  anime:  'anime character illustration',
  '3d':   '3D rendered character',
  animal: 'anthropomorphic animal character',
  robot:  'robot character',
};

const GENDER_MAP: Record<Gender, string> = {
  male:   'man',
  female: 'woman',
};

const AGE_MAP: Record<AgeRange, string> = {
  '20s':  'in their 20s',
  '30s':  'in their 30s',
  '40s':  'in their 40s',
  '50s+': 'in their 50s or older',
};

const OUTFIT_MAP: Record<Outfit, string> = {
  business_suit: 'wearing a sharp business suit',
  casual:        'in smart casual attire',
  white_coat:    'wearing a white lab coat',
  uniform:       'in a professional uniform',
};

const ANIMAL_KIND_MAP: Record<AnimalKind, string> = {
  dog:   'dog',
  cat:   'cat',
  bird:  'bird',
  bear:  'bear',
  fox:   'fox',
  other: 'animal',
};

const ANIMAL_VIBE_MAP: Record<AnimalVibe, string> = {
  cute:  'cute and adorable',
  cool:  'cool and stylish',
  silly: 'funny and goofy',
};

const ROBOT_DESIGN_MAP: Record<RobotDesign, string> = {
  simple: 'sleek minimalist white robot',
  mecha:  'powerful mechanical mecha robot',
  scifi:  'futuristic sci-fi android',
  cute:   'cute friendly round robot',
};

const COMPOSITION_MAP: Record<Composition, string> = {
  face_close: 'extreme close-up portrait, face only',
  bust:       'bust shot, chest and face visible',
  half_body:  'half body shot, waist up',
  full_body:  'full body shot',
};

const EXPRESSION_MAP: Record<Expression, string> = {
  smile:   'warm friendly smile, approachable expression',
  serious: 'professional serious expression, confident',
  cool:    'cool composed expression, stylish demeanor',
  gentle:  'gentle kind expression, warm eyes',
};

const BACKGROUND_MAP: Record<Background, string> = {
  simple:  'clean neutral gray studio background',
  office:  'modern professional office background with soft bokeh',
  cafe:    'cozy warm cafe background with soft bokeh',
  custom:  'clean studio background',
};

const QUALITY_SUFFIX =
  'high quality, professional lighting, sharp focus, 8k resolution, award-winning photography, centered composition, looking at camera';

const NEGATIVE_SUFFIX =
  'blurry, distorted, extra limbs, deformed, watermark, text, nsfw, low quality, pixelated';

// ── メインビルド関数 ──────────────────────────────────────────────────────────

export function buildAvatarPrompt(input: AvatarPromptInput): {
  prompt: string;
  negativePrompt: string;
} {
  const parts: string[] = [];

  // Subject
  parts.push(SUBJECT[input.type]);

  // Type-specific details
  switch (input.type) {
    case 'human': {
      const genderStr = input.gender ? `Japanese ${GENDER_MAP[input.gender]}` : 'Japanese person';
      const ageStr = input.age ? AGE_MAP[input.age] : '';
      const outfitStr = input.outfit ? OUTFIT_MAP[input.outfit] : '';
      parts.push(`of a ${[genderStr, ageStr].filter(Boolean).join(', ')}`);
      if (outfitStr) parts.push(outfitStr);
      break;
    }
    case 'anime': {
      const genderStr = input.gender ? `${GENDER_MAP[input.gender]} ` : '';
      parts.push(`of a ${genderStr}anime-style character, cel-shaded, vibrant colors`);
      break;
    }
    case '3d': {
      const genderStr = input.gender ? `${GENDER_MAP[input.gender]} ` : '';
      parts.push(`of a ${genderStr}Pixar-style 3D character, smooth render, subsurface scattering`);
      break;
    }
    case 'animal': {
      const kindStr = input.animalKind ? ANIMAL_KIND_MAP[input.animalKind] : 'animal';
      const vibeStr = input.animalVibe ? ANIMAL_VIBE_MAP[input.animalVibe] : '';
      parts.push(`of a ${[vibeStr, `anthropomorphic ${kindStr}`].filter(Boolean).join(' ')}`);
      parts.push('wearing business attire, standing upright');
      break;
    }
    case 'robot': {
      const designStr = input.robotDesign ? ROBOT_DESIGN_MAP[input.robotDesign] : 'robot';
      parts.push(`${designStr}`);
      break;
    }
  }

  // Composition
  parts.push(COMPOSITION_MAP[input.composition]);

  // Expression
  parts.push(EXPRESSION_MAP[input.expression]);

  // Background
  const bgStr = input.background === 'custom' && input.customBgColor
    ? `solid color background (${input.customBgColor})`
    : BACKGROUND_MAP[input.background];
  parts.push(bgStr);

  // Quality
  parts.push(QUALITY_SUFFIX);

  return {
    prompt: parts.join(', '),
    negativePrompt: NEGATIVE_SUFFIX,
  };
}
