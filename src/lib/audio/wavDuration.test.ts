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
});
