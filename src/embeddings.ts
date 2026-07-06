// BGE-small-en-v1.5 requires a query prefix for asymmetric search.
// Passage (memory content) gets no prefix — the model was trained
// to encode passages without instruction.
const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

/**
 * Interface for an embedding model so tests can supply a mock.
 * `name` is the tag stored alongside each entry so a future reader can tell
 * which model produced a vector; recall discriminates spaces by dimension,
 * not by tag.
 */
export interface EmbeddingModel {
  readonly loaded: boolean;
  readonly name: string;
  load(): Promise<void>;
  queryEmbed(text: string): Promise<Float32Array>;
  passageEmbed(text: string): Promise<Float32Array>;
}

/**
 * Lazy-loads an embedding model via @huggingface/transformers.
 * Model files (~34 MB for the default) are downloaded once and cached by HF Hub.
 */
export class BgeEmbeddingModel implements EmbeddingModel {
  #modelName: string;
  #pipe: any = null;
  #loading: Promise<void> | null = null;

  constructor(modelName = "Xenova/bge-small-en-v1.5") {
    this.#modelName = modelName;
  }

  get loaded(): boolean {
    return this.#pipe !== null;
  }

  get name(): string {
    return this.#modelName;
  }

  // Memoizes the in-flight load so concurrent embed calls share one model
  // initialization. A failed load clears the memo so a later call can retry.
  async load(): Promise<void> {
    if (this.#pipe) return;
    this.#loading ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      this.#pipe = await pipeline("feature-extraction", this.#modelName);
    })().catch((err) => {
      this.#loading = null;
      throw err;
    });
    await this.#loading;
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
 * Mock embedding model for tests. Returns deterministic vectors derived from
 * a hash of the input text via xorshift, so identical texts embed identically
 * and distinct texts land near-orthogonal — mirroring how unrelated content
 * behaves in a real embedding space. Never loads a model or touches the network.
 */
export class MockEmbeddingModel implements EmbeddingModel {
  readonly dims = 384;
  readonly name = "mock";
  loaded = true;

  async load(): Promise<void> {}

  async queryEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  async passageEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  #embed(text: string): Float32Array {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    h ^= 0x9e3779b9; // avoid the degenerate all-zero state for empty input

    const vec = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h |= 0;
      vec[i] = h / 0x80000000;
    }
    return vec;
  }
}
