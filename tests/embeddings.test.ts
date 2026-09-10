import { describe, test, expect } from "bun:test";
import { MockEmbeddingModel } from "./mocks/embeddings";
import {
  BgeEmbeddingModel,
  backendMode,
  configureBackend,
  resetBackendForTests,
  type PipelineFactory,
} from "../src/embeddings";

describe("MockEmbeddingModel", () => {
  test("reports dims correctly", () => {
    const model = new MockEmbeddingModel();
    expect(model.dims).toBe(384);
  });

  test("reports loaded as true", () => {
    const model = new MockEmbeddingModel();
    expect(model.loaded).toBe(true);
  });

  test("load is a no-op", async () => {
    const model = new MockEmbeddingModel();
    await model.load(); // should not throw
  });

  test("queryEmbed returns deterministic non-zero vector", async () => {
    const model = new MockEmbeddingModel();
    const vec = await model.queryEmbed("hello");
    expect(vec.length).toBe(384);
    expect(vec[0]).not.toBe(0);
  });

  test("passageEmbed returns deterministic non-zero vector", async () => {
    const model = new MockEmbeddingModel();
    const vec = await model.passageEmbed("hello");
    expect(vec.length).toBe(384);
    expect(vec[0]).not.toBe(0);
  });

  test("same text produces same vector regardless of embed type", async () => {
    const model = new MockEmbeddingModel();
    const q = await model.queryEmbed("hello");
    const p = await model.passageEmbed("hello");
    expect(q).toEqual(p);
  });

  test("different texts produce different vectors", async () => {
    const model = new MockEmbeddingModel();
    const a = await model.passageEmbed("alpha");
    const b = await model.passageEmbed("beta");
    // Should differ in at least one position
    const differs = a.some((v, i) => v !== b[i]);
    expect(differs).toBe(true);
  });

  test("unrelated texts land near-orthogonal, like a real embedding space", async () => {
    const { cosineSimilarity } = await import("../src/db");
    const model = new MockEmbeddingModel();
    const a = await model.passageEmbed("the sqlite schema uses WAL mode");
    const b = await model.passageEmbed("cats enjoy sitting in cardboard boxes");
    // Sine-wave vectors used to score >0.85 for arbitrary text pairs, blowing
    // past the dedup threshold; hash-seeded vectors must not.
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.3);
  });

  test("exposes a model name for the stored tag", () => {
    const model = new MockEmbeddingModel();
    expect(model.name).toBe("mock");
  });

  test("dispose flips the disposed flag", async () => {
    const model = new MockEmbeddingModel();
    expect(model.disposed).toBe(false);
    await model.dispose();
    expect(model.disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BgeEmbeddingModel (with injected pipeline factory)
// ---------------------------------------------------------------------------

describe("BgeEmbeddingModel", () => {
  // Mock pipeline factory that returns a fake pipeline producing deterministic vectors
  function createMockPipelineFactory(dims = 384): {
    factory: PipelineFactory;
    callCount: () => number;
    disposeCount: () => number;
  } {
    let calls = 0;
    let disposals = 0;
    const factory: PipelineFactory = async (_modelName) => {
      calls++;
      const pipe = async (text: string, _opts: any) => {
        // Produce a deterministic vector from text hash (like MockEmbeddingModel)
        let h = 0;
        for (let i = 0; i < text.length; i++) {
          h = ((h << 5) - h) + text.charCodeAt(i);
          h |= 0;
        }
        h ^= 0x9e3779b9;
        const vec = new Float32Array(dims);
        for (let i = 0; i < dims; i++) {
          h ^= h << 13;
          h ^= h >>> 17;
          h ^= h << 5;
          h |= 0;
          vec[i] = h / 0x80000000;
        }
        return { data: vec };
      };
      pipe.dispose = async () => {
        disposals++;
      };
      return pipe;
    };
    return { factory, callCount: () => calls, disposeCount: () => disposals };
  }

  test("reports loaded as false before load", () => {
    const { factory } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);
    expect(model.loaded).toBe(false);
  });

  test("reports loaded as true after load", async () => {
    const { factory } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);
    await model.load();
    expect(model.loaded).toBe(true);
  });

  test("lazy-loads on first embed call", async () => {
    const { factory, callCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);

    expect(callCount()).toBe(0);
    await model.passageEmbed("hello");
    expect(callCount()).toBe(1);
  });

  test("memoizes load across concurrent calls", async () => {
    const { factory, callCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);

    // Fire multiple embed calls concurrently
    await Promise.all([
      model.passageEmbed("one"),
      model.passageEmbed("two"),
      model.queryEmbed("three"),
    ]);

    // Pipeline factory should only be called once
    expect(callCount()).toBe(1);
  });

  test("retries load after failure", async () => {
    let attempts = 0;
    const failingFactory: PipelineFactory = async () => {
      attempts++;
      if (attempts === 1) throw new Error("Network error");
      return async () => ({ data: new Float32Array(384) });
    };

    const model = new BgeEmbeddingModel("test-model", failingFactory);

    // First call fails
    await expect(model.passageEmbed("hello")).rejects.toThrow("Network error");
    expect(attempts).toBe(1);
    expect(model.loaded).toBe(false);

    // Second call succeeds
    await model.passageEmbed("hello");
    expect(attempts).toBe(2);
    expect(model.loaded).toBe(true);
  });

  test("queryEmbed prefixes text for asymmetric search", async () => {
    let capturedText = "";
    const factory: PipelineFactory = async () => {
      return async (text: string, _opts: any) => {
        capturedText = text;
        return { data: new Float32Array(384) };
      };
    };

    const model = new BgeEmbeddingModel("test-model", factory);
    await model.queryEmbed("hello world");

    expect(capturedText).toContain("Represent this sentence for searching relevant passages:");
    expect(capturedText).toContain("hello world");
  });

  test("passageEmbed does not prefix text", async () => {
    let capturedText = "";
    const factory: PipelineFactory = async () => {
      return async (text: string, _opts: any) => {
        capturedText = text;
        return { data: new Float32Array(384) };
      };
    };

    const model = new BgeEmbeddingModel("test-model", factory);
    await model.passageEmbed("hello world");

    expect(capturedText).toBe("hello world");
    expect(capturedText).not.toContain("Represent this sentence");
  });

  test("exposes model name for the stored tag", () => {
    const { factory } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("custom-model-name", factory);
    expect(model.name).toBe("custom-model-name");
  });

  test("uses default model name when not specified", () => {
    const { factory } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel(undefined, factory);
    expect(model.name).toBe("Xenova/bge-small-en-v1.5");
  });

  test("dispose before load is a no-op", async () => {
    const { factory, callCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);

    await model.dispose();

    expect(model.loaded).toBe(false);
    expect(callCount()).toBe(0);
  });

  test("dispose releases the pipeline and clears loaded", async () => {
    const { factory, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);
    await model.passageEmbed("hello");
    expect(model.loaded).toBe(true);

    await model.dispose();

    expect(model.loaded).toBe(false);
    expect(disposeCount()).toBe(1);
  });

  test("dispose is idempotent", async () => {
    const { factory, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);
    await model.load();

    await model.dispose();
    await model.dispose();

    expect(disposeCount()).toBe(1);
  });

  test("dispose waits for an in-flight load", async () => {
    const { factory, callCount, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);

    // Start the load without awaiting it, then dispose while it is suspended.
    const loading = model.load();
    await model.dispose();
    await loading;

    expect(callCount()).toBe(1);
    expect(disposeCount()).toBe(1);
    expect(model.loaded).toBe(false);
  });

  test("embed after dispose lazily re-loads", async () => {
    const { factory, callCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory);
    await model.passageEmbed("hello");
    await model.dispose();

    await model.passageEmbed("hello again");

    expect(model.loaded).toBe(true);
    expect(callCount()).toBe(2);
  });

  test("dispose swallows a failed load memo", async () => {
    let attempts = 0;
    const failingFactory: PipelineFactory = async () => {
      attempts++;
      throw new Error("Network error");
    };
    const model = new BgeEmbeddingModel("test-model", failingFactory);

    // Start the load without settling its rejection first, so dispose runs
    // while the memo still holds the rejecting promise. Its error must be
    // swallowed by dispose, not rethrown as dispose's own failure.
    const failed = model.passageEmbed("hello").catch(() => {});
    await expect(model.dispose()).resolves.toBeUndefined();
    await failed;
    expect(attempts).toBe(1);
  });

  test("idle timeout releases the pipeline and clears loaded", async () => {
    const { factory, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 10 });
    await model.passageEmbed("hello");
    expect(model.loaded).toBe(true);

    await Bun.sleep(60);

    expect(model.loaded).toBe(false);
    expect(disposeCount()).toBe(1);
  });

  test("embed resets the idle timer", async () => {
    const { factory, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 50 });
    await model.passageEmbed("first");
    await Bun.sleep(30);
    await model.passageEmbed("second");
    await Bun.sleep(30);
    // 60ms since the first embed, but only 30ms since the second reset.
    expect(model.loaded).toBe(true);
    expect(disposeCount()).toBe(0);

    await Bun.sleep(40);
    expect(model.loaded).toBe(false);
    expect(disposeCount()).toBe(1);
  });

  test("idle fire after dispose is a no-op", async () => {
    const { factory, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 10 });
    await model.passageEmbed("hello");

    await model.dispose();
    await Bun.sleep(40);

    expect(disposeCount()).toBe(1);
    expect(model.loaded).toBe(false);
  });

  test("idleTtlMs 0 disables idle disposal", async () => {
    const { factory, disposeCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 0 });
    await model.passageEmbed("hello");

    await Bun.sleep(40);

    expect(model.loaded).toBe(true);
    expect(disposeCount()).toBe(0);
  });

  test("embed after idle release lazily re-loads", async () => {
    const { factory, callCount } = createMockPipelineFactory();
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 10 });
    await model.passageEmbed("first");
    await Bun.sleep(60);
    expect(model.loaded).toBe(false);

    await model.passageEmbed("second");

    expect(model.loaded).toBe(true);
    expect(callCount()).toBe(2);
  });

  test("disposes the output tensor after copying data", async () => {
    const vec = new Float32Array(384).fill(0.5);
    let tensorDisposes = 0;
    const factory: PipelineFactory = async () => {
      const pipe = async (_text: string, _opts: any) => ({
        data: vec,
        dispose: async () => {
          tensorDisposes++;
        },
      });
      pipe.dispose = async () => {};
      return pipe;
    };
    // idleTtlMs 0 keeps the two disposal mechanisms independent: this only
    // exercises per-call tensor release, not session release.
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 0 });
    const out = await model.passageEmbed("hello");

    expect(tensorDisposes).toBe(1);
    expect(out[0]).toBe(0.5);
  });

  test("pipeline without a tensor dispose method still embeds", async () => {
    const factory: PipelineFactory = async () => {
      return async (_text: string, _opts: any) => ({ data: new Float32Array(384) });
    };
    const model = new BgeEmbeddingModel("test-model", factory, { idleTtlMs: 0 });
    const out = await model.passageEmbed("hello");

    expect(out.length).toBe(384);
  });
});

// ---------------------------------------------------------------------------
// Embedding backend selection
// ---------------------------------------------------------------------------

describe("embedding backend", () => {
  test("backendMode defaults to wasm", () => {
    const saved = process.env.THATCH_EMBEDDING_BACKEND;
    try {
      delete process.env.THATCH_EMBEDDING_BACKEND;
      expect(backendMode()).toBe("wasm");
    } finally {
      if (saved === undefined) delete process.env.THATCH_EMBEDDING_BACKEND;
      else process.env.THATCH_EMBEDDING_BACKEND = saved;
    }
  });

  test("backendMode opts out to native", () => {
    const saved = process.env.THATCH_EMBEDDING_BACKEND;
    try {
      process.env.THATCH_EMBEDDING_BACKEND = "native";
      expect(backendMode()).toBe("native");
    } finally {
      if (saved === undefined) delete process.env.THATCH_EMBEDDING_BACKEND;
      else process.env.THATCH_EMBEDDING_BACKEND = saved;
    }
  });

  test("backendMode treats unknown values as wasm", () => {
    const saved = process.env.THATCH_EMBEDDING_BACKEND;
    try {
      process.env.THATCH_EMBEDDING_BACKEND = "garbage";
      expect(backendMode()).toBe("wasm");
    } finally {
      if (saved === undefined) delete process.env.THATCH_EMBEDDING_BACKEND;
      else process.env.THATCH_EMBEDDING_BACKEND = saved;
    }
  });

  test("configureBackend pins onnxruntime-web and single-threads wasm", async () => {
    // Other test files initialize the plugin server, whose behavior seeding
    // embeds and pins the backend symbol as a side effect. Reset that state
    // so this test exercises the pinning path itself, then restore whatever
    // was there for later files.
    delete process.env.THATCH_EMBEDDING_BACKEND;
    const globals = globalThis as Record<symbol, any>;
    const savedOrt = globals[Symbol.for("onnxruntime")];
    resetBackendForTests();

    try {
      const mode = await configureBackend();

      expect(mode).toBe("wasm");
      const ort = globals[Symbol.for("onnxruntime")];
      expect(ort).toBeDefined();
      expect(ort.env.wasm.numThreads).toBe(1);
    } finally {
      resetBackendForTests();
      if (savedOrt !== undefined) {
        globals[Symbol.for("onnxruntime")] = savedOrt;
      }
    }
  });
});
