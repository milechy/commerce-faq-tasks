-- Phase64: Fish Audio 18体音声割り当て
-- 全is_default=trueレコードに対してdefault_voice_idを設定
-- 実行: psql 'postgresql://...' -f migration_voice_assignment.sql
-- ※ Fish Audio IDは 2025-04-15 時点の実API応答から取得

-- 01 Haruka — 元気な女性v2 (likes:306, energetic, bright, cheerful)
UPDATE avatar_configs SET default_voice_id = '63bc41e652214372b15d9416a30a60b4' WHERE is_default = true AND name = 'Haruka';

-- 02 Rei — 佐藤 葵 (likes:143, bright, energetic, friendly)
UPDATE avatar_configs SET default_voice_id = 'f787e74f89d84b148bb5355fda204641' WHERE is_default = true AND name = 'Rei';

-- 03 Sophia — Paula (likes:1152, professional, confident, clear)
UPDATE avatar_configs SET default_voice_id = 'c2623f0c075b4492ac367989aee1576f' WHERE is_default = true AND name = 'Sophia';

-- 04 Unit-PX7 — 落ち着いた女性 (likes:239, soft, warm, calm, gentle)
UPDATE avatar_configs SET default_voice_id = '0089dce5fefb4c6ba9b9f2f0debe1ddc' WHERE is_default = true AND name = 'Unit-PX7';

-- 05 Ambassador ZOG — 落ち着いた男性 (likes:231, calm, professional, confident)
UPDATE avatar_configs SET default_voice_id = '45c5d3723c9c42f598e4776dcfd5f02d' WHERE is_default = true AND name = 'Ambassador ZOG';

-- 06 MITSU — 沢城みゆき (likes:217, soft, calm, friendly)
UPDATE avatar_configs SET default_voice_id = 'c9896cee621f46c3b8f60b2490ffd310' WHERE is_default = true AND name = 'MITSU';

-- 07 SAM — ななみん (likes:492, deep, calm, smooth)
UPDATE avatar_configs SET default_voice_id = '71bf4cb71cd44df6aa603d51db8f92ff' WHERE is_default = true AND name = 'SAM';

-- 08 KOHAKU — しぬしぬボイス (likes:445, young, expressive, dramatic)
UPDATE avatar_configs SET default_voice_id = '1fcb900b5ae349ab92ec33fe532b8ea1' WHERE is_default = true AND name = 'KOHAKU';

-- 09 ARJUN — シャア・アズナブル 平和的に (likes:286, deep, authoritative, documentary)
UPDATE avatar_configs SET default_voice_id = '9f21d9d25a5e4690bd504ef91b1a0e93' WHERE is_default = true AND name = 'ARJUN';

-- 10 ELENA — まな (likes:588, warm, professional, middle-aged)
UPDATE avatar_configs SET default_voice_id = 'fbea303b64374bffb8843569404b095e' WHERE is_default = true AND name = 'ELENA';

-- 11 KWAME — 男性ナレーター (likes:177, deep, calm, serious)
UPDATE avatar_configs SET default_voice_id = 'bb3bf6a073cb48c1a5b6c436053ce243' WHERE is_default = true AND name = 'KWAME';

-- 12 BELLA — 田中みなみ風 (likes:229, professional, warm, host)
UPDATE avatar_configs SET default_voice_id = 'ac870f5b0f7e45609b4e8d79bc4082ff' WHERE is_default = true AND name = 'BELLA';

-- 13 LI — つの (likes:200, middle-aged, deep, calm)
UPDATE avatar_configs SET default_voice_id = 'a365c3050dd04026a81291145e017d6f' WHERE is_default = true AND name = 'LI';

-- 14 BARKLEY — 士道 (likes:140, calm, professional, gentle)
UPDATE avatar_configs SET default_voice_id = '8f99ad75c8184f1db0c21d3a906445a4' WHERE is_default = true AND name = 'BARKLEY';

-- 15 NYX — ゆりVer1 (likes:153, energetic, friendly, confident)
UPDATE avatar_configs SET default_voice_id = '34d29f836f4a4da9a1d13619dc35574a' WHERE is_default = true AND name = 'NYX';

-- 16 SIR PEN — 五条悟 (likes:189, smooth, confident, anime)
UPDATE avatar_configs SET default_voice_id = '827be896a6954a8199ce4b2baad6af36' WHERE is_default = true AND name = 'SIR PEN';

-- 17 CAPTAIN KOALA — Light Yagami Japanese V2 (likes:142, deep, calm, serious)
UPDATE avatar_configs SET default_voice_id = '4bc1d3d1fa60415f989b8e0b99f333e1' WHERE is_default = true AND name = 'CAPTAIN KOALA';

-- 18 SERAPH — Phat phap(Bro) (likes:728, deep, calm, British Accent)
UPDATE avatar_configs SET default_voice_id = 'e0e2468ce2d746c1b20a4414435f6f48' WHERE is_default = true AND name = 'SERAPH';

-- 確認クエリ
SELECT
  default_template_id,
  name,
  default_voice_id,
  CASE WHEN default_voice_id IS NOT NULL THEN 'SET' ELSE 'NULL' END AS voice_status
FROM avatar_configs
WHERE is_default = true
ORDER BY default_template_id, tenant_id
LIMIT 36;
