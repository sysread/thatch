// BGE-small-en-v1.5 requires a query prefix for asymmetric search.
// Passage (memory content) gets no prefix - the model was trained
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
  dispose(): Promise<void>;
}

/**
 * Factory for creating a Hugging Face feature-extraction pipeline.
 * Injected into BgeEmbeddingModel for testability.
 */
export type PipelineFactory = (modelName: string) => Promise<any>;

const defaultPipelineFactory: PipelineFactory = async (modelName) => {
  const { pipeline } = await import("@huggingface/transformers");
  return pipeline("feature-extraction", modelName);
};

/**
 * Lazy-loads an embedding model via @huggingface/transformers.
 * Model files (~34 MB for the default) are downloaded once and cached by HF Hub.
 */
export class BgeEmbeddingModel implements EmbeddingModel {
  #modelName: string;
  #pipelineFactory: PipelineFactory;
  #pipe: any = null;
  #loading: Promise<void> | null = null;

  constructor(modelName = "Xenova/bge-small-en-v1.5", pipelineFactory?: PipelineFactory) {
    this.#modelName = modelName;
    this.#pipelineFactory = pipelineFactory ?? defaultPipelineFactory;
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
      this.#pipe = await this.#pipelineFactory(this.#modelName);
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

  /**
   * Releases the pipeline's native ONNX sessions. The host calls this during
   * graceful shutdown so onnxruntime's NAPI wrap finalizers are freed while
   * the runtime is still alive. If instead they survive to Bun's worker
   * teardown, Bun panics creating their errors (oven-sh/bun#34664).
   *
   * Best-effort by design: dispose never throws, and a failed release is
   * indistinguishable from never loading. An embed call after dispose just
   * lazily re-loads the model.
   */
  async dispose(): Promise<void> {
    // An in-flight load memoizes a rejecting promise on failure. Await it
    // defensively so its error neither escapes dispose nor kills the teardown.
    if (this.#loading) {
      try {
        await this.#loading;
      } catch {
        // Load failed - nothing was loaded, so nothing to release.
      }
    }
    const pipe = this.#pipe;
    this.#pipe = null;
    this.#loading = null;
    if (!pipe) return;
    try {
      await pipe.dispose();
    } catch {
      // Best-effort - see doc comment above.
    }
  }
}
