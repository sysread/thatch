import { describe, test, expect } from "bun:test";
import { MockEmbeddingModel, BgeEmbeddingModel, type PipelineFactory } from "../src/embeddings";

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
});

// ---------------------------------------------------------------------------
// BgeEmbeddingModel (with injected pipeline factory)
// ---------------------------------------------------------------------------

describe("BgeEmbeddingModel", () => {
  // Mock pipeline factory that returns a fake pipeline producing deterministic vectors
  function createMockPipelineFactory(dims = 384): { factory: PipelineFactory; callCount: () => number } {
    let calls = 0;
    const factory: PipelineFactory = async (_modelName) => {
      calls++;
      return async (text: string, _opts: any) => {
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
    };
    return { factory, callCount: () => calls };
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
});
