import { describe, test, expect } from "bun:test";
import { MockEmbeddingModel } from "../src/embeddings";

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
});
