// src/lib/audio/wavDuration.test.ts

import { parseWavDurationSeconds } from './wavDuration';

function buildWavBuffer({
  sampleRate = 44100,
  numChannels = 1,
  bitsPerSample = 16,
  dataBytes = 88200,
}: Partial<{
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataBytes: number;
}> = {}): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const fmtChunkSize = 16;
  const dataChunkSize = dataBytes;
  const riffChunkSize = 4 + (8 + fmtChunkSize) + (8 + dataChunkSize);

  const buf = Buffer.alloc(12 + 8 + fmtChunkSize + 8 + dataChunkSize);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(riffChunkSize, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(fmtChunkSize, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2; // PCM
  buf.writeUInt16LE(numChannels, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(byteRate, o); o += 4;
  buf.writeUInt16LE(blockAlign, o); o += 2;
  buf.writeUInt16LE(bitsPerSample, o); o += 2;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataChunkSize, o); o += 4;
  return buf;
}

// 任意のチャンク列からWAVバッファを組み立てる低レベルヘルパー。
// 実録音アプリ/ブラウザが付与するLIST/INFO等の余剰チャンクや、
// fmt/dataの出現順序が非標準なケースを再現するために使う。
function chunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0);
  header.writeUInt32LE(data.length, 4);
  const padding = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, data, padding]);
}

function fmtChunkData({ sampleRate = 44100, numChannels = 1, bitsPerSample = 16 } = {}): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const d = Buffer.alloc(16);
  d.writeUInt16LE(1, 0);
  d.writeUInt16LE(numChannels, 2);
  d.writeUInt32LE(sampleRate, 4);
  d.writeUInt32LE(byteRate, 8);
  d.writeUInt16LE(blockAlign, 12);
  d.writeUInt16LE(bitsPerSample, 14);
  return d;
}

function buildWavFromChunks(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8);
  return Buffer.concat([header, body]);
}

describe('parseWavDurationSeconds', () => {
  it('正常WAV: 44.1kHz/16bit/モノラルで88200バイト(=1秒分)のdataは1.0秒を返す', () => {
    const buf = buildWavBuffer({ dataBytes: 88200 });
    expect(parseWavDurationSeconds(buf)).toBeCloseTo(1.0);
  });

  it('正常WAV: 半分のバイト数(44100)は0.5秒を返す', () => {
    const buf = buildWavBuffer({ dataBytes: 44100 });
    expect(parseWavDurationSeconds(buf)).toBeCloseTo(0.5);
  });

  it('ヘッダ欠損: fmtチャンクが途中で切れている場合は null を返す', () => {
    const full = buildWavBuffer({ dataBytes: 1000 });
    const truncated = full.subarray(0, 20); // "fmt " チャンクの途中で切る
    expect(parseWavDurationSeconds(truncated)).toBeNull();
  });

  it('非WAVバイト列: RIFF/WAVEマーカーがない場合は null を返す', () => {
    const notWav = Buffer.from('this is not a wav file at all, just random text bytes');
    expect(parseWavDurationSeconds(notWav)).toBeNull();
  });

  it('0バイト: 空バッファは null を返す', () => {
    expect(parseWavDurationSeconds(Buffer.alloc(0))).toBeNull();
  });

  // ── 実世界のWAVで頻出する非標準パターン ─────────────────────────────
  it('実世界パターン: fmtとdataの間にLISTチャンク(メタデータ)が挟まっても正しく解析できる', () => {
    // 録音アプリ/DAWがタイトル・作者等のメタデータをLISTチャンクとして
    // fmtとdataの間に挟むことがある。88200バイトのPCMデータ=1.0秒。
    const buf = buildWavFromChunks([
      chunk('fmt ', fmtChunkData()),
      chunk('LIST', Buffer.from('INFOIART\x05\x00\x00\x00Me\x00\x00\x00')), // 奇数長データで自動パディング検証も兼ねる
      chunk('data', Buffer.alloc(88200)),
    ]);
    expect(parseWavDurationSeconds(buf)).toBeCloseTo(1.0);
  });

  it('実世界パターン: LISTチャンクがRIFFヘッダ直後・fmtより前に来ても正しく解析できる', () => {
    const buf = buildWavFromChunks([
      chunk('LIST', Buffer.from('INFOIART\x04\x00\x00\x00Test')),
      chunk('fmt ', fmtChunkData()),
      chunk('data', Buffer.alloc(44100)), // 0.5秒
    ]);
    expect(parseWavDurationSeconds(buf)).toBeCloseTo(0.5);
  });

  it('奇数長チャンクのパディングを正しくスキップする(パディングバイトを読み飛ばさないとチャンクIDがズレて誤判定/nullになる)', () => {
    // 奇数長(999バイト)のLISTチャンクの後に1バイトのパディングが入る。
    // パディング計算を誤ると次の"data"の4バイトIDがズレて読めなくなる。
    const oddSizedList = Buffer.alloc(999, 0x41);
    const buf = buildWavFromChunks([
      chunk('fmt ', fmtChunkData()),
      chunk('LIST', oddSizedList),
      chunk('data', Buffer.alloc(22050)), // 0.25秒
    ]);
    expect(parseWavDurationSeconds(buf)).toBeCloseTo(0.25);
  });

  it('順序異常: dataチャンクがfmtより前に出現しても最終的に両方揃えば解析できる', () => {
    const buf = buildWavFromChunks([
      chunk('data', Buffer.alloc(44100)),
      chunk('fmt ', fmtChunkData()),
    ]);
    expect(parseWavDurationSeconds(buf)).toBeCloseTo(0.5);
  });

  it('破損ヘッダ: fmtチャンクのbyteRateが0の場合はnullを返す(ゼロ除算を起こさない)', () => {
    const corruptFmt = Buffer.alloc(16); // 全フィールド0、byteRateも0
    const buf = buildWavFromChunks([
      chunk('fmt ', corruptFmt),
      chunk('data', Buffer.alloc(1000)),
    ]);
    expect(parseWavDurationSeconds(buf)).toBeNull();
  });

  it('壊れたヘッダ: dataチャンクの宣言サイズが実際のバッファ長を超える場合、実データ量に丸めて計算する(クラッシュや負の値にしない)', () => {
    // ブラウザのMediaRecorderが録音途中でタブが閉じられた等でストリームが
    // 打ち切られると、ヘッダの宣言サイズと実データが食い違うことがある。
    const buf = buildWavFromChunks([
      chunk('fmt ', fmtChunkData()),
    ]);
    // dataチャンクヘッダだけ手書きし、宣言サイズ(1,000,000バイト)に対し
    // 実際のバッファには44100バイトしか続かない状態を作る。
    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0);
    dataHeader.writeUInt32LE(1_000_000, 4);
    const truncatedBuf = Buffer.concat([buf, dataHeader, Buffer.alloc(44100)]);

    const result = parseWavDurationSeconds(truncatedBuf);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(0.5); // 実際に存在する44100バイト分として計算される
  });

  it('fmtチャンクのサイズが16バイト未満(拡張フィールドの手前で切れている)場合はnullを返す', () => {
    const shortFmtHeader = Buffer.alloc(8);
    shortFmtHeader.write('fmt ', 0);
    shortFmtHeader.writeUInt32LE(16, 4); // 16バイトあると宣言しているが実際は10バイトしかない
    const buf = Buffer.concat([
      Buffer.from('RIFF\x00\x00\x00\x00WAVE'),
      shortFmtHeader,
      Buffer.alloc(10),
    ]);
    expect(parseWavDurationSeconds(buf)).toBeNull();
  });
});
