import { homedir } from "node:os";
import { join } from "node:path";

// BGE-small-en-v1.5 requires a query prefix for asymmetric search.
// Passage (memory content) gets no prefix - the model was trained
// to encode passages without instruction. Exported so the mock model's
// query derivation can apply the same prefix the real pipeline sees.
export const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

/**
 * Writable directory for the downloaded model files.
 *
 * transformers.js defaults its filesystem cache to a `.cache` folder *inside*
 * its own package directory (`node_modules/@huggingface/transformers/.cache`).
 * That breaks any read-only install - a global `bun install -g`, and Nix store
 * paths in particular - and gets wiped on every reinstall. Anchor the cache in
 * the platform's per-user cache location instead so it survives upgrades and
 * works from an immutable store path.
 *
 *   THATCH_MODEL_CACHE  explicit override (highest priority)
 *   XDG_CACHE_HOME      explicit base dir -> $XDG_CACHE_HOME/thatch/models
 *   macOS              ~/Library/Caches/thatch/models
 *   Windows            %LOCALAPPDATA%\thatch\models
 *   Linux / other      ~/.cache/thatch/models
 *
 * `platform` and `home` are injectable for testing; they default to the real
 * runtime values.
 */
export function modelCacheDir(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const env = process.env;
  if (env.THATCH_MODEL_CACHE) return env.THATCH_MODEL_CACHE;
  // Respect an explicit XDG override on any platform (some macOS users set it).
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "thatch", "models");
  const base =
    platform === "darwin"
      ? join(home, "Library", "Caches")
      : platform === "win32"
        ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
        : join(home, ".cache");
  return join(base, "thatch", "models");
}

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

const ORT_SYMBOL = Symbol.for("onnxruntime");

let backendConfigured: Promise<void> | null = null;

/**
 * Pins the ONNX runtime before transformers initializes. Memoized: the
 * choice is made once at transformers' module init and cannot be changed
 * afterwards. Exported for tests.
 *
 * Pins globalThis[Symbol.for("onnxruntime")] to onnxruntime-web so
 * transformers' node build creates sessions on its pure-JS/wasm runtime
 * instead of the onnxruntime-node NAPI addon (transformers imports that
 * addon unconditionally, but the pin makes it unreachable). A runtime
 * already chosen by the host (symbol present) is respected, never
 * clobbered. A failed onnxruntime-web import leaves the runtime choice to
 * transformers rather than blocking embedding.
 */
export async function configureBackend(): Promise<void> {
  backendConfigured ??= (async () => {
    if (ORT_SYMBOL in globalThis) return;
    try {
      const ort = await import("onnxruntime-web");
      (globalThis as Record<symbol, unknown>)[ORT_SYMBOL] = ort;
      // Single-threaded wasm: deterministic, and avoids worker_threads,
      // where Bun has known shutdown crashes. Latency at one thread is fine
      // for background embedding.
      ort.env.wasm.numThreads = 1;
    } catch {
      // onnxruntime-web unavailable - transformers selects the runtime itself.
    }
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
  await configureBackend();
  const { pipeline, env } = await import("@huggingface/transformers");
  // Redirect the model cache out of the (possibly read-only) package tree.
  env.cacheDir = modelCacheDir();
  // The ORT_SYMBOL override branch leaves transformers' device allowlist
  // empty, so any named device throws; "auto" bypasses the check and the
  // explicit execution provider does the real work.
  return pipeline("feature-extraction", modelName, {
    device: "auto",
    session_options: { executionProviders: ["wasm"] },
  });
};

/**
 * How long a loaded pipeline may sit unused before its ONNX sessions
 * are released while the runtime is still healthy. Long enough to span the
 * gap between extraction bursts, short enough to matter before process exit.
 */
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;

export interface BgeEmbeddingModelOptions {
  /**
   * Idle milliseconds before the pipeline's sessions are released.
   * A later embed lazily re-loads. 0 disables idle release.
   */
  idleTtlMs?: number;
}

/**
 * Process-wide model pool, keyed by db path. A v2 serve hosts one plugin
 * instance per location and each would otherwise keep its own ONNX model
 * resident; the pool refcounts so N instances share one model and it is
 * disposed only when the last holder releases (the model's ONNX sessions
 * must be explicitly closed before process exit - the dispose-before-exit
 * contract; the NAPI-finalizer panic that motivated it applied to the
 * retired native backend, see BgeEmbeddingModel.dispose).
 */
export class SharedModelPool {
  #entries = new Map<string, { model: BgeEmbeddingModel; refs: number }>();

  acquire(dbPath: string, modelName: string): BgeEmbeddingModel {
    const entry = this.#entries.get(dbPath);
    if (entry) {
      entry.refs += 1;
      return entry.model;
    }
    const created = { model: new BgeEmbeddingModel(modelName), refs: 1 };
    this.#entries.set(dbPath, created);
    return created.model;
  }

  /**
   * Release one reference. Resolves when the model's ONNX sessions are
   * released (at zero refs) - the caller MUST await it before its process
   * can exit (the dispose-before-exit contract; see BgeEmbeddingModel.dispose).
   */
  async release(dbPath: string): Promise<void> {
    const entry = this.#entries.get(dbPath);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.#entries.delete(dbPath);
      await entry.model.dispose();
    }
  }

  /** Test/introspection: number of live (held) models. */
  get size(): number {
    return this.#entries.size;
  }
}

/**
 * The embedding model every surface uses when THATCH_MODEL is unset. Lives
 * here beside the factory: the daemon's hello handshake compares this name
 * ACROSS processes, so every construction site must read one constant - a
 * drifted hand-copied default would read as a model mismatch and silently
 * local-lock every session.
 */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

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
    modelName: string = DEFAULT_EMBEDDING_MODEL,
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
   * Releases the pipeline's ONNX sessions. The host calls this during
   * graceful shutdown. The NAPI wrap finalizers whose survival panicked
   * Bun at teardown (oven-sh/bun#34664) belonged to the removed native
   * backend; the dispose call stays as interface contract - every
   * EmbeddingModel is await-disposed before its process exits - and as
   * native-memory hygiene for the wasm runtime.
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

/**
 * Derives one deterministic embedding vector from the exact input text
 * (xorshift over the character codes). Shared by the mock model class here
 * and the in-process test mock in tests/mocks/embeddings.ts, so the vector
 * algorithm cannot drift between the in-process and subprocess tiers.
 */
export function mockEmbeddingVector(text: string, dims = 384): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  h ^= 0x9e3779b9; // avoid the degenerate all-zero state for empty input

  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h |= 0;
    vec[i] = h / 0x80000000;
  }
  return vec;
}

/** The model name the embedding factory maps to MockEmbeddingModel. */
export const MOCK_MODEL_NAME = "mock";

/**
 * The hermetic model behind THATCH_MODEL=mock. Deterministic vectors from
 * the exact input text - the query path applies the same QUERY_PREFIX the
 * real pipeline applies - with no network, no download, and no ONNX
 * runtime. Supported in production source on purpose: the spawned tiers
 * (MCP server, embed daemon, hook one-shots) need embeds that succeed and
 * reproduce bit-for-bit across processes, which is what makes the
 * integration tests and the QA use cases hermetic. Without this branch,
 * THATCH_MODEL=mock in the QA suites had no effect: every embed failed.
 */
export class MockEmbeddingModel implements EmbeddingModel {
  readonly loaded = true;
  readonly name = MOCK_MODEL_NAME;

  async load(): Promise<void> {}

  // Nothing was loaded, so there is nothing to release; the await keeps the
  // dispose-before-exit contract callers rely on.
  async dispose(): Promise<void> {}

  async queryEmbed(text: string): Promise<Float32Array> {
    return mockEmbeddingVector(QUERY_PREFIX + text);
  }

  async passageEmbed(text: string): Promise<Float32Array> {
    return mockEmbeddingVector(text);
  }
}

/**
 * The embedding factory: one name, one model implementation. Every
 * construction site that honors THATCH_MODEL builds through this - the
 * plugin, the MCP server, the daemon, and the CLI embed commands - so the
 * mock branch is reachable from every tier at once. The one surviving
 * non-goal is the daemon RESOLVER, not the factory: the CLI one-shots
 * construct the model here but never resolve the shared daemon (a recorded
 * decision in docs/plans/embedding-daemon.md) - they always embed
 * in-process.
 */
export function createEmbeddingModel(modelName: string): EmbeddingModel {
  if (modelName === MOCK_MODEL_NAME) return new MockEmbeddingModel();
  return new BgeEmbeddingModel(modelName);
}
