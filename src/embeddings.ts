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
 * Mock embedding model for tests. Returns deterministic non-zero vectors
 * derived from the input text, so different inputs produce different
 * embeddings and cosine similarity yields meaningful scores.
 * Never loads a real model or makes network calls.
 */
export class MockEmbeddingModel implements EmbeddingModel {
  readonly dims = 384;
  loaded = true;

  async load(): Promise<void> {}

  async queryEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  async passageEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  #embed(text: string): Float32Array {
    const vec = new Float32Array(this.dims);
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    for (let i = 0; i < this.dims; i++) {
      vec[i] = Math.sin(h * 0.01 + i * 0.1);
    }
    return vec;
  }
}
