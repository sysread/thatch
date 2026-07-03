// BGE-small-en-v1.5 requires a query prefix for asymmetric search.
// Passage (memory content) gets no prefix — the model was trained
// to encode passages without instruction.
const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

/**
 * Interface for an embedding model so tests can supply a mock.
 */
export interface EmbeddingModel {
  readonly loaded: boolean;
  readonly dims: number;
  load(): Promise<void>;
  queryEmbed(text: string): Promise<Float32Array>;
  passageEmbed(text: string): Promise<Float32Array>;
}

/**
 * Lazy-loads bge-small-en-v1.5 via @huggingface/transformers.
 * Model files (~34 MB) are downloaded once and cached by HF Hub.
 */
export class BgeEmbeddingModel implements EmbeddingModel {
  readonly dims = 384;
  #modelName: string;
  #pipe: any = null;

  constructor(modelName = "Xenova/bge-small-en-v1.5") {
    this.#modelName = modelName;
  }

  get loaded(): boolean {
    return this.#pipe !== null;
  }

  async load(): Promise<void> {
    if (this.#pipe) return;
    const { pipeline } = await import("@huggingface/transformers");
    this.#pipe = await pipeline("feature-extraction", this.#modelName);
  }

  async queryEmbed(text: string): Promise<Float32Array> {
    return this.#embed(QUERY_PREFIX + text);
  }

  async passageEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  async #embed(text: string): Promise<Float32Array> {
    await this.load();
    const output = await this.#pipe(text, {
      pooling: "mean",
      normalize: true,
    });
    return output.data as Float32Array;
  }
}

/**
 * Mock embedding model for tests. Returns a fixed vector.
 * Never loads a real model or makes network calls.
 */
export class MockEmbeddingModel implements EmbeddingModel {
  readonly dims = 384;
  loaded = true;

  async load(): Promise<void> {}

  async queryEmbed(_text: string): Promise<Float32Array> {
    return new Float32Array(this.dims).fill(0.01);
  }

  async passageEmbed(_text: string): Promise<Float32Array> {
    // Deterministic but unique per call — just zeros is fine for tests
    return new Float32Array(this.dims);
  }
}
