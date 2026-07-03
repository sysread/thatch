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

  test("queryEmbed returns fixed vector", async () => {
    const model = new MockEmbeddingModel();
    const vec = await model.queryEmbed("any query");
    expect(vec.length).toBe(384);
    expect(vec[0]).toBeCloseTo(0.01, 2);
  });

  test("passageEmbed returns zero vector", async () => {
    const model = new MockEmbeddingModel();
    const vec = await model.passageEmbed("any passage");
    expect(vec.length).toBe(384);
    expect(vec[0]).toBe(0);
  });
});
