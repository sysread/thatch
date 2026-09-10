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

/**
 * Embedding backend mode. "wasm" runs the ONNX model on onnxruntime-web's
 * pure-JS/wasm runtime; "native" runs it on onnxruntime-node's NAPI addon.
 */
export type EmbeddingBackendMode = "wasm" | "native";

/**
 * Reads the backend override. Only "native" opts out; any other value,
 * including unset, selects the wasm default. Exported for tests.
 */
export function backendMode(): EmbeddingBackendMode {
  return process.env.THATCH_EMBEDDING_BACKEND === "native" ? "native" : "wasm";
}

const ORT_SYMBOL = Symbol.for("onnxruntime");

let backendConfigured: Promise<EmbeddingBackendMode> | null = null;

/**
 * Chooses the ONNX backend before transformers initializes. Memoized: the
 * choice is made once at transformers' module init and cannot be changed
 * afterwards. Exported for tests.
 *
 * "wasm" mode pins globalThis[Symbol.for("onnxruntime")] to onnxruntime-web
 * so transformers' node build creates sessions on its pure-JS/wasm runtime
 * instead of the onnxruntime-node NAPI addon. The NAPI addon leaves wrap
 * finalizers that panic Bun at process teardown (oven-sh/bun#34664); the wasm
 * runtime creates none. A backend already chosen by the host (symbol present)
 * is respected, never clobbered. A failed onnxruntime-web import falls back
 * to native rather than blocking embedding.
 */
export async function configureBackend(): Promise<EmbeddingBackendMode> {
  backendConfigured ??= (async () => {
    const mode = backendMode();
    if (mode === "native" || ORT_SYMBOL in globalThis) return mode;
    try {
      const ort = await import("onnxruntime-web");
      (globalThis as Record<symbol, unknown>)[ORT_SYMBOL] = ort;
      // Single-threaded wasm: deterministic, and avoids worker_threads,
      // where Bun has known shutdown crashes. Latency at one thread is fine
      // for background embedding.
      ort.env.wasm.numThreads = 1;
    } catch {
      // onnxruntime-web unavailable - native sessions still work.
    }
    return mode;
  })();
  return backendConfigured;
}

/**
 * Test hook: clears the configureBackend memo and unpins the onnxruntime
 * global, so a test can exercise the pinning path itself. Needed because the
 * test process is shared across files: initializing the plugin server seeds
 * behaviors, which embeds, which runs configureBackend and pins the symbol
 * as a side effect. Whether that happened before a given test file runs
 * depends on bun's file order, which differs between machines.
 */
export function resetBackendForTests(): void {
  backendConfigured = null;
  delete (globalThis as Record<symbol, unknown>)[ORT_SYMBOL];
}

const defaultPipelineFactory: PipelineFactory = async (modelName) => {
  const mode = await configureBackend();
  const { pipeline } = await import("@huggingface/transformers");
  if (mode === "native") {
    return pipeline("feature-extraction", modelName);
  }
  // The ORT_SYMBOL override branch leaves transformers' device allowlist
  // empty, so any named device throws; "auto" bypasses the check and the
  // explicit execution provider does the real work.
  return pipeline("feature-extraction", modelName, {
    device: "auto",
    session_options: { executionProviders: ["wasm"] },
  });
};

/**
 * How long a loaded pipeline may sit unused before its native ONNX sessions
 * are released while the runtime is still healthy. Long enough to span the
 * gap between extraction bursts, short enough to matter before process exit.
 */
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;

export interface BgeEmbeddingModelOptions {
  /**
   * Idle milliseconds before the pipeline's native sessions are released.
   * A later embed lazily re-loads. 0 disables idle release.
   */
  idleTtlMs?: number;
}

/**
 * Lazy-loads an embedding model via @huggingface/transformers.
 * Model files (~34 MB for the default) are downloaded once and cached by HF Hub.
 */
export class BgeEmbeddingModel implements EmbeddingModel {
  #modelName: string;
  #pipelineFactory: PipelineFactory;
  #idleTtlMs: number;
  #pipe: any = null;
  #loading: Promise<void> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    modelName = "Xenova/bge-small-en-v1.5",
    pipelineFactory?: PipelineFactory,
    options: BgeEmbeddingModelOptions = {},
  ) {
    this.#modelName = modelName;
    this.#pipelineFactory = pipelineFactory ?? defaultPipelineFactory;
    this.#idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
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
    // Clear any pending idle timer before touching the pipeline. The timer
    // must never fire while an embed is in flight - its callback releases
    // the pipeline this call is about to use.
    this.#clearIdleTimer();
    try {
      await this.load();
      const pipe = this.#pipe;
      const output = await pipe(text, {
        pooling: "mean",
        normalize: true,
      });
      // Copy the vector before releasing the tensor: the real Tensor's data
      // getter exposes memory the disposer frees.
      const data = new Float32Array(output.data);
      if (typeof output?.dispose === "function") {
        try {
          await output.dispose();
        } catch {
          // Tensor release is best-effort; the copied data is already valid.
        }
      }
      return data;
    } finally {
      this.#armIdleTimer();
    }
  }

  /**
   * Releases the pipeline's native ONNX sessions. The host calls this during
   * graceful shutdown so onnxruntime's NAPI wrap finalizers are freed while
   * the runtime is still alive. If instead they survive to Bun's worker
   * teardown, Bun panics creating their errors (oven-sh/bun#34664).
   *
   * The idle timer releases on the same principle during normal operation:
   * the plugin's dispose hook is best-effort because opencode can exit
   * without running it, so sessions are also freed after a quiet period.
   *
   * Best-effort by design: dispose never throws, and a failed release is
   * indistinguishable from never loading. An embed call after dispose just
   * lazily re-loads the model.
   */
  async dispose(): Promise<void> {
    this.#clearIdleTimer();
    // An in-flight load memoizes a rejecting promise on failure. Await it
    // defensively so its error neither escapes dispose nor kills the teardown.
    if (this.#loading) {
      try {
        await this.#loading;
      } catch {
        // Load failed - nothing was loaded, so nothing to release.
      }
    }
    await this.#release();
  }

  async #release(): Promise<void> {
    const pipe = this.#pipe;
    this.#pipe = null;
    this.#loading = null;
    if (!pipe) return;
    try {
      await pipe.dispose();
    } catch {
      // Best-effort - see dispose's doc comment.
    }
  }

  #armIdleTimer(): void {
    if (this.#idleTtlMs <= 0) return;
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.#release().catch(() => {
        // Idle release is best-effort; a failed release retries on dispose.
      });
    }, this.#idleTtlMs);
    // Never hold the host process open for an idle timer.
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }
}
