import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// findBy* / waitFor の既定タイムアウトは testing-library の 1000ms。
// CI(GitHub Actions)は実行環境が遅く、描画に複数の非同期段(fetchモックの解決 →
// state更新 → 再描画)を挟むテストがこの1秒に間に合わずランダムに落ちていた。
// 代表例: copilot-preview の Voice Design 群(「この声にする」ボタンが見つからない)。
// 同じコミットでも run ごとに pass/fail が割れ、変更と無関係のPRを Gate 3 が
// 落としていた(Asana GID 1217807802247077。2026-08-29 にも #1050 で再発を確認)。
//
// ★これは「遅いテストを通す」ための延長ではない★
// 本当に壊れているテストは 5000ms でも落ちる。延ばして困るのは失敗確定までの
// 待ち時間だけで、その代償はフレークによる再実行(1回あたり Gate 3 で約2分 +
// 人間の判断コスト)より小さい。
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
