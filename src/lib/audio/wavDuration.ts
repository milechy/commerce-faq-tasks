// GID 1217083837550916: Fish Audio ASRの原価をリクエスト単位の概算値ではなく
// 実際の録音秒数で計上するため、アップロードされたWAVバイト列から再生時間を算出する。

const RIFF_HEADER_SIZE = 12; // "RIFF" + size(4) + "WAVE"
const CHUNK_HEADER_SIZE = 8; // chunkId(4) + chunkSize(4)

/**
 * WAVファイルのヘッダを解析して再生時間(秒)を返す。
 * 壊れたヘッダ・非WAVバイト列・fmt/dataチャンク欠損時は例外を投げず null を返す。
 */
export function parseWavDurationSeconds(buf: Buffer): number | null {
  if (buf.length < RIFF_HEADER_SIZE) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = RIFF_HEADER_SIZE;
  let byteRate: number | null = null;
  let dataSize: number | null = null;

  while (offset + CHUNK_HEADER_SIZE <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataStart = offset + CHUNK_HEADER_SIZE;

    if (chunkId === 'fmt ') {
      if (chunkDataStart + 16 > buf.length) return null;
      byteRate = buf.readUInt32LE(chunkDataStart + 8);
    } else if (chunkId === 'data') {
      // 宣言サイズが実データを超える壊れたヘッダは、実際に残っているバイト数に丸める
      dataSize = Math.min(chunkSize, buf.length - chunkDataStart);
    }

    if (byteRate !== null && dataSize !== null) break;

    // チャンクは偶数バイト境界にパディングされる
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || byteRate <= 0 || dataSize === null || dataSize < 0) return null;
  return dataSize / byteRate;
}
