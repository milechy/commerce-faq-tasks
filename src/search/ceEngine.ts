// src/search/ceEngine.ts

import * as fs from "node:fs";
import * as path from "node:path";

export type CeEngineName = "dummy" | "onnx" | "remote";

export interface CeEngineConfig {
  /** CE に渡す候補数（最大件数） */
  candidates: number;
  /** CE を有効にするためのクエリ文字数の下限 */
  minQueryChars: number;
  /** CE 実行時の最大バッチサイズ */
  maxBatchSize: number;
}

export interface CeEngineStatus {
  engine: CeEngineName;
  onnxLoaded: boolean;
  modelPath: string | null;
  error: string | null;
  config: CeEngineConfig;
  warmedUp: boolean;
}

export interface CeEngine {
  /** 現在のエンジン名（dummy / onnx / remote） */
  readonly name: CeEngineName;

  /** モデルロードなどの初期化処理を行う（idempotent を想定） */
  warmup(): Promise<CeEngineStatus>;

  /** 現在のステータスを返す（/ce/status 用） */
  status(): CeEngineStatus;

  /**
   * クエリとドキュメント群に対して Cross-Encoder スコアを返す。
   * scores の長さと順序は docs と同一であること。
   */
  scoreBatch(
    query: string,
    docs: string[],
    opts?: {
      abortSignal?: AbortSignal;
    }
  ): Promise<number[]>;
}

function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number,
  minValue = 1
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  const v = Math.floor(n);
  if (v < minValue) return defaultValue;
  return v;
}

function readConfigFromEnv(): CeEngineConfig {
  const candidates = parsePositiveInt(process.env.CE_CANDIDATES, 24, 1);
  const minQueryChars = parsePositiveInt(process.env.CE_MIN_QUERY_CHARS, 8, 1);
  const maxBatchSize = parsePositiveInt(process.env.CE_MAX_BATCH_SIZE, 16, 1);

  return {
    candidates,
    minQueryChars,
    maxBatchSize,
  };
}

/**
 * 環境変数 CE_ENGINE から希望するエンジン名を取得する。
 * 未設定や未知の値の場合は "dummy" を返す。
 */
function resolveEngineNameFromEnv(): CeEngineName {
  const raw = (process.env.CE_ENGINE ?? "").toLowerCase();
  // CE_ENGINE の解決状況をログに出しておくと、ローカル検証時に原因調査しやすい
  // ※本番でノイズになるようであれば、log レベルや出力先を調整すること
  // eslint-disable-next-line no-console
  console.log("[CeEngine] resolveEngineNameFromEnv", {
    CE_ENGINE: process.env.CE_ENGINE,
    raw,
  });

  if (raw === "onnx") return "onnx";
  if (raw === "remote") return "remote";
  return "dummy";
}

/**
 * Cross-Encoder 用の簡易 tokenizer インターフェース。
 * Phase18 では「構造」を決めることが目的なので、
 * 実運用では HuggingFace 等の tokenizer 実装で置き換える前提。
 */
interface CeTokenizer {
  encodePair(
    query: string,
    doc: string,
    maxSeqLen: number
  ): {
    inputIds: number[]; // 長さ maxSeqLen
    attentionMask: number[]; // 長さ maxSeqLen
    tokenTypeIds: number[]; // 長さ maxSeqLen（モデルが不要なら全部 0 で OK）
  };
}

/**
 * BERT 系 Cross-Encoder 用の vocab 構造。
 */
interface BertVocab {
  tokenToId: Map<string, number>;
  idToToken: string[];
  unkId: number;
  clsId: number;
  sepId: number;
  padId: number;
}

function loadBertVocab(vocabPath: string): BertVocab {
  const resolved = path.isAbsolute(vocabPath)
    ? vocabPath
    : path.join(process.cwd(), vocabPath);
  const content = fs.readFileSync(resolved, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

  const tokenToId = new Map<string, number>();
  const idToToken: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const token = lines[i].trim();
    if (!token) continue;
    tokenToId.set(token, i);
    idToToken[i] = token;
  }

  const getId = (t: string, fallback: number): number =>
    tokenToId.get(t) ?? fallback;

  const unkId = getId("[UNK]", 100);
  const clsId = getId("[CLS]", 101);
  const sepId = getId("[SEP]", 102);
  const padId = getId("[PAD]", 0);

  return { tokenToId, idToToken, unkId, clsId, sepId, padId };
}

/**
 * ごく簡略化した WordPiece tokenizer。
 * - 実際の HuggingFace 実装とは完全一致しないが、
 *   Phase18 では「CE パイプラインの形」を整えることを優先。
 */
class SimpleWordPieceTokenizer {
  private readonly vocab: BertVocab;
  private readonly maxInputCharsPerWord = 100;

  constructor(vocab: BertVocab) {
    this.vocab = vocab;
  }

  tokenize(text: string): string[] {
    const tokens: string[] = [];
    const words = text
      .toLowerCase()
      .split(/[\s\u3000]+/)
      .filter((w) => w.length > 0);

    for (const word of words) {
      if (word.length > this.maxInputCharsPerWord) {
        tokens.push("[UNK]");
        continue;
      }

      const subTokens: string[] = [];
      let start = 0;
      let isBad = false;

      while (start < word.length) {
        let end = word.length;
        let curSubstr: string | null = null;

        while (start < end) {
          let substr = word.slice(start, end);
          if (start > 0) {
            substr = "##" + substr;
          }

          if (this.vocab.tokenToId.has(substr)) {
            curSubstr = substr;
            break;
          }
          end -= 1;
        }

        if (curSubstr === null) {
          isBad = true;
          break;
        }

        subTokens.push(curSubstr);
        start = end;
      }

      if (isBad) {
        tokens.push("[UNK]");
      } else {
        tokens.push(...subTokens);
      }
    }

    return tokens;
  }

  convertTokensToIds(tokens: string[]): number[] {
    return tokens.map((t) => this.vocab.tokenToId.get(t) ?? this.vocab.unkId);
  }

  get clsId(): number {
    return this.vocab.clsId;
  }

  get sepId(): number {
    return this.vocab.sepId;
  }

  get padId(): number {
    return this.vocab.padId;
  }
}

/**
 * CE_VOCAB_PATH が設定されていない、または読み込みに失敗した場合に使う
 * フォールバック用の簡易 tokenizer。
 */
function createFallbackTokenizer(): CeTokenizer {
  return {
    encodePair(query: string, doc: string, maxSeqLen: number) {
      const text = `${query} [SEP] ${doc}`.trim();
      const tokens = text.length > 0 ? text.split(/\s+/) : [];
      const ids: number[] = [];

      for (const t of tokens) {
        ids.push(t.length);
        if (ids.length >= maxSeqLen) break;
      }

      const inputIds = new Array<number>(maxSeqLen).fill(0);
      const attentionMask = new Array<number>(maxSeqLen).fill(0);

      const len = Math.min(ids.length, maxSeqLen);
      for (let i = 0; i < len; i += 1) {
        inputIds[i] = ids[i];
        attentionMask[i] = 1;
      }
      const tokenTypeIds = new Array<number>(maxSeqLen).fill(0);
      return { inputIds, attentionMask, tokenTypeIds };
    },
  };
}

/**
 * 実モデル前提の tokenizer を生成する。
 * - CE_VOCAB_PATH が設定されていれば BERT/WordPiece vocab を利用
 * - 未設定または読み込み失敗時は安全にフォールバック実装を用いる
 */
function createCeTokenizer(): CeTokenizer {
  const vocabPath = process.env.CE_VOCAB_PATH;
  if (!vocabPath) {
    return createFallbackTokenizer();
  }

  try {
    const vocab = loadBertVocab(vocabPath);
    const wp = new SimpleWordPieceTokenizer(vocab);

    return {
      encodePair(query: string, doc: string, maxSeqLen: number) {
        // [CLS] query [SEP] doc [SEP]
        const qTokens = wp.tokenize(query);
        const dTokens = wp.tokenize(doc);

        // [CLS] query [SEP] doc [SEP]
        const maxTokens = maxSeqLen - 3; // [CLS], [SEP], [SEP]
        let qSlice = qTokens;
        let dSlice = dTokens;

        if (qTokens.length + dTokens.length > maxTokens) {
          const maxDocTokens = Math.max(0, maxTokens - qTokens.length);
          dSlice = dTokens.slice(0, maxDocTokens);
        }

        const tokens: string[] = [
          "[CLS]",
          ...qSlice,
          "[SEP]",
          ...dSlice,
          "[SEP]",
        ];

        const tokenTypes: number[] = [
          0, // [CLS]
          ...new Array<number>(qSlice.length).fill(0),
          0, // [SEP]
          ...new Array<number>(dSlice.length).fill(1),
          1, // [SEP]
        ];

        let inputIds = wp.convertTokensToIds(tokens);
        inputIds = inputIds.slice(0, maxSeqLen);
        const tokenTypeIdsSliced = tokenTypes.slice(0, maxSeqLen);

        const padId = wp.padId;
        const attentionMask = new Array<number>(maxSeqLen).fill(0);
        const padded = new Array<number>(maxSeqLen).fill(padId);
        const tokenTypeIds = new Array<number>(maxSeqLen).fill(0);

        const len = Math.min(inputIds.length, maxSeqLen);
        for (let i = 0; i < len; i += 1) {
          padded[i] = inputIds[i];
          attentionMask[i] = 1;
          tokenTypeIds[i] = tokenTypeIdsSliced[i] ?? 0;
        }

        return {
          inputIds: padded,
          attentionMask,
          tokenTypeIds,
        };
      },
    };
  } catch (_e) {
    // vocab 読み込みに失敗した場合も、安全のためフォールバックに切り替える。
    return createFallbackTokenizer();
  }
}

class DummyCeEngine implements CeEngine {
  public readonly name: CeEngineName = "dummy";

  private readonly config: CeEngineConfig;
  private warmedUp = false;

  constructor() {
    this.config = readConfigFromEnv();
  }

  async warmup(): Promise<CeEngineStatus> {
    this.warmedUp = true;
    return this.status();
  }

  status(): CeEngineStatus {
    return {
      engine: this.name,
      onnxLoaded: false,
      modelPath: null,
      error: null,
      config: this.config,
      warmedUp: this.warmedUp,
    };
  }

  async scoreBatch(
    _query: string,
    docs: string[],
    _opts?: { abortSignal?: AbortSignal }
  ): Promise<number[]> {
    // ひとまず dummy 実装として、すべて 0 スコアを返す。
    if (docs.length === 0) return [];
    return docs.map(() => 0);
  }
}

class OnnxCeEngine implements CeEngine {
  public readonly name: CeEngineName = "onnx";

  private readonly config: CeEngineConfig;
  private readonly modelPath: string | null;
  private warmedUp = false;
  private onnxLoaded = false;
  private error: string | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any | null = null;

  // 実際の CE モデルに合わせて調整可能なパラメータ。
  private readonly maxSeqLen: number;
  private inputIdsName: string;
  private attentionMaskName: string;
  private tokenTypeIdsName: string | null;
  private outputName: string;
  private outputIndex: number;

  private readonly tokenizer: CeTokenizer;

  constructor() {
    this.config = readConfigFromEnv();
    this.modelPath = process.env.CE_MODEL_PATH ?? null;

    // モデル仕様に合わせて env から変更できるようにしておく。
    this.maxSeqLen = Number(process.env.CE_MAX_SEQ_LEN ?? "256") || 256;
    this.inputIdsName = process.env.CE_INPUT_IDS_NAME ?? "input_ids";
    this.attentionMaskName =
      process.env.CE_ATTENTION_MASK_NAME ?? "attention_mask";
    this.outputName = process.env.CE_OUTPUT_NAME ?? "logits";
    this.tokenTypeIdsName = process.env.CE_TOKEN_TYPE_IDS_NAME ?? null;

    // logits が [B,2] のような場合にどの index を score として採用するか（通常 0 or 1）。
    // 単一 logit の場合は無視される。
    this.outputIndex = Number(process.env.CE_OUTPUT_INDEX ?? "0") || 0;

    this.tokenizer = createCeTokenizer();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveIoNamesFromSession(session: any): void {
    const inputNames: string[] = Array.isArray(session.inputNames)
      ? session.inputNames
      : [];
    const outputNames: string[] = Array.isArray(session.outputNames)
      ? session.outputNames
      : [];

    const findByIncludes = (names: string[], key: string): string | null => {
      const lowerKey = key.toLowerCase();
      const hit = names.find((n) => n.toLowerCase().includes(lowerKey));
      return hit ?? null;
    };

    // env で明示されていない場合は自動推測する
    if (!process.env.CE_INPUT_IDS_NAME) {
      this.inputIdsName =
        findByIncludes(inputNames, "input_ids") ??
        inputNames[0] ??
        this.inputIdsName;
    }

    if (!process.env.CE_ATTENTION_MASK_NAME) {
      this.attentionMaskName =
        findByIncludes(inputNames, "attention_mask") ??
        findByIncludes(inputNames, "attention") ??
        this.attentionMaskName;
    }

    // token_type_ids はモデルによって必要/不要がある。入力に存在する場合のみ使う。
    if (!process.env.CE_TOKEN_TYPE_IDS_NAME) {
      const inferred = findByIncludes(inputNames, "token_type_ids");
      this.tokenTypeIdsName = inferred;
    }

    if (!process.env.CE_OUTPUT_NAME) {
      this.outputName =
        findByIncludes(outputNames, "logits") ??
        outputNames[0] ??
        this.outputName;
    }

    // eslint-disable-next-line no-console
    console.log("[CeEngine] ONNX IO resolved", {
      inputNames,
      outputNames,
      inputIdsName: this.inputIdsName,
      attentionMaskName: this.attentionMaskName,
      tokenTypeIdsName: this.tokenTypeIdsName,
      outputName: this.outputName,
      outputIndex: this.outputIndex,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getTensorDTypeFromSession(
    session: any,
    name: string
  ): "int64" | "int32" {
    const meta = session.inputMetadata?.[name];
    const t = typeof meta?.type === "string" ? meta.type : "int64";
    return t === "int32" ? "int32" : "int64";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async ensureSession(): Promise<any> {
    if (this.session) return this.session;
    const status = await this.warmup();
    if (!status.onnxLoaded || !this.session) {
      throw new Error(status.error ?? "ONNX session is not available");
    }
    return this.session;
  }

  async warmup(): Promise<CeEngineStatus> {
    // すでにロード済みで正常なら何もしない（idempotent）
    if (this.session && this.onnxLoaded && !this.error) {
      this.warmedUp = true;
      return this.status();
    }

    // 「一度でも warmup を呼んだ」フラグは立てるが、
    // 未ロード/失敗状態であれば再試行できるようにする。
    this.warmedUp = true;

    if (!this.modelPath) {
      this.error = "CE_MODEL_PATH is not set";
      this.onnxLoaded = false;
      this.session = null;
      return this.status();
    }

    try {
      // onnxruntime-node は重いので、warmup 時に初回ロードする。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ort = require("onnxruntime-node");
      if (!ort) {
        this.error = "onnxruntime-node could not be loaded";
        this.onnxLoaded = false;
        this.session = null;
        return this.status();
      }

      // 実際の Session をここで作成する。
      // モデル側の入出力は CE モデルに合わせて調整すること。
      this.session = await ort.InferenceSession.create(this.modelPath);
      this.resolveIoNamesFromSession(this.session);

      // session が作れた時点で loaded 扱い
      this.onnxLoaded = true;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.onnxLoaded = false;
      this.session = null;
    }

    return this.status();
  }

  status(): CeEngineStatus {
    const loaded = !!this.session && this.onnxLoaded && !this.error;

    return {
      engine: this.name,
      onnxLoaded: loaded,
      modelPath: this.modelPath,
      error: this.error,
      config: this.config,
      warmedUp: this.warmedUp,
    };
  }

  async scoreBatch(
    query: string,
    docs: string[],
    opts?: { abortSignal?: AbortSignal }
  ): Promise<number[]> {
    if (docs.length === 0) return [];

    const abortSignal = opts?.abortSignal;
    if (abortSignal?.aborted) {
      throw new Error("Cross-Encoder scoring aborted");
    }

    const session = await this.ensureSession();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ort = require("onnxruntime-node");

    const maxBatch = Math.max(1, this.config.maxBatchSize);
    const total = docs.length;
    const scores: number[] = new Array(total);
    const seqLen = this.maxSeqLen;

    for (let start = 0; start < total; start += maxBatch) {
      if (abortSignal?.aborted) {
        throw new Error("Cross-Encoder scoring aborted");
      }

      const end = Math.min(start + maxBatch, total);
      const batchDocs = docs.slice(start, end);
      const batchSize = batchDocs.length;

      const inputDType = this.getTensorDTypeFromSession(
        session,
        this.inputIdsName
      );

      const idsData =
        inputDType === "int32"
          ? new Int32Array(batchSize * seqLen)
          : new BigInt64Array(batchSize * seqLen);
      const maskData =
        inputDType === "int32"
          ? new Int32Array(batchSize * seqLen)
          : new BigInt64Array(batchSize * seqLen);

      const needsTokenTypeIds =
        this.tokenTypeIdsName !== null &&
        typeof this.tokenTypeIdsName === "string" &&
        this.tokenTypeIdsName.length > 0;

      const typeData = needsTokenTypeIds
        ? inputDType === "int32"
          ? new Int32Array(batchSize * seqLen)
          : new BigInt64Array(batchSize * seqLen)
        : null;

      for (let i = 0; i < batchSize; i += 1) {
        const doc = batchDocs[i];
        const { inputIds, attentionMask, tokenTypeIds } =
          this.tokenizer.encodePair(query, doc, seqLen);

        if (
          inputIds.length !== seqLen ||
          attentionMask.length !== seqLen ||
          tokenTypeIds.length !== seqLen
        ) {
          throw new Error(
            `tokenizer.encodePair must return length=${seqLen}, got ids=${inputIds.length}, mask=${attentionMask.length}, typeIds=${tokenTypeIds.length}`
          );
        }

        const offset = i * seqLen;
        for (let j = 0; j < seqLen; j += 1) {
          if (inputDType === "int32") {
            (idsData as Int32Array)[offset + j] = inputIds[j] | 0;
            (maskData as Int32Array)[offset + j] = attentionMask[j] | 0;
            if (typeData)
              (typeData as Int32Array)[offset + j] = tokenTypeIds[j] | 0;
          } else {
            (idsData as BigInt64Array)[offset + j] = BigInt(inputIds[j]);
            (maskData as BigInt64Array)[offset + j] = BigInt(attentionMask[j]);
            if (typeData)
              (typeData as BigInt64Array)[offset + j] = BigInt(tokenTypeIds[j]);
          }
        }
      }

      const inputIdsTensor = new ort.Tensor(inputDType, idsData as any, [
        batchSize,
        seqLen,
      ]);
      const attentionMaskTensor = new ort.Tensor(inputDType, maskData as any, [
        batchSize,
        seqLen,
      ]);

      const tokenTypeIdsTensor =
        typeData && this.tokenTypeIdsName
          ? new ort.Tensor(inputDType, typeData as any, [batchSize, seqLen])
          : null;

      const feeds: Record<string, unknown> = {
        [this.inputIdsName]: inputIdsTensor,
        [this.attentionMaskName]: attentionMaskTensor,
      };
      if (tokenTypeIdsTensor && this.tokenTypeIdsName) {
        feeds[this.tokenTypeIdsName] = tokenTypeIdsTensor;
      }

      if (abortSignal?.aborted) {
        throw new Error("Cross-Encoder scoring aborted");
      }

      const outputs = await session.run(feeds);

      const outputTensor = outputs[this.outputName];
      if (!outputTensor) {
        throw new Error(`ONNX output '${this.outputName}' not found`);
      }

      const raw = outputTensor.data as Float32Array | Float64Array | number[];
      const rawArr = Array.from(raw as any).map((v: unknown) => Number(v));

      const dims: number[] = Array.isArray(outputTensor.dims)
        ? (outputTensor.dims as number[])
        : [];
      const lastDim = dims.length >= 2 ? dims[dims.length - 1] : 1;
      const stride = lastDim && lastDim > 0 ? lastDim : 1;

      for (let i = 0; i < batchSize; i += 1) {
        const globalIndex = start + i;

        let score: number;
        if (dims.length === 1 || stride === 1) {
          score = rawArr[i];
        } else {
          const idx = Math.max(0, Math.min(stride - 1, this.outputIndex));
          score = rawArr[i * stride + idx];
        }

        scores[globalIndex] = Number.isFinite(score) ? score : 0;
      }
    }

    return scores;
  }
}

class RemoteCeEngine implements CeEngine {
  public readonly name: CeEngineName = "remote";

  private readonly config: CeEngineConfig;
  private warmedUp = false;

  constructor() {
    this.config = readConfigFromEnv();
  }

  async warmup(): Promise<CeEngineStatus> {
    // Phase18 では未実装。将来のための placeholder。
    this.warmedUp = true;
    return this.status();
  }

  status(): CeEngineStatus {
    return {
      engine: this.name,
      onnxLoaded: false,
      modelPath: null,
      error: "remote CE engine is not implemented",
      config: this.config,
      warmedUp: this.warmedUp,
    };
  }

  async scoreBatch(
    _query: string,
    docs: string[],
    _opts?: { abortSignal?: AbortSignal }
  ): Promise<number[]> {
    // 未実装のため、dummy と同じ挙動にしておく。
    if (docs.length === 0) return [];
    return docs.map(() => 0);
  }
}

let cachedEngine: CeEngine | null = null;

export function getCeEngine(): CeEngine {
  if (cachedEngine) return cachedEngine;

  const name = resolveEngineNameFromEnv();

  // CE 関連の環境変数を起動時に一度だけログに出しておく
  // CE_ENGINE が dummy になってしまう / モデルパスがずれている等のトラブル調査用。
  // eslint-disable-next-line no-console
  console.log("[CeEngine] initializing", {
    resolvedEngine: name,
    CE_ENGINE: process.env.CE_ENGINE,
    CE_MODEL_PATH: process.env.CE_MODEL_PATH,
    CE_VOCAB_PATH: process.env.CE_VOCAB_PATH,
    CE_MAX_SEQ_LEN: process.env.CE_MAX_SEQ_LEN,
  });

  if (name === "onnx") {
    cachedEngine = new OnnxCeEngine();
  } else if (name === "remote") {
    cachedEngine = new RemoteCeEngine();
  } else {
    cachedEngine = new DummyCeEngine();
  }
  return cachedEngine;
}

/**
 * Jest などのテスト用に、内部のシングルトンをリセットするための関数。
 * 本番コードからは呼ばない前提。
 */
export function __resetCeEngineForTests(): void {
  cachedEngine = null;
}
