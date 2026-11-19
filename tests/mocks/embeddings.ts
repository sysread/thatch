import { mockEmbeddingVector } from "../../src/embeddings";
import type { EmbeddingModel } from "../../src/embeddings";

/**
 * Mock embedding model for tests. Returns deterministic vectors derived from
 * a hash of the input text via xorshift, so identical texts embed identically
 * and distinct texts land near-orthogonal - mirroring how unrelated content
 * behaves in a real embedding space. Never loads a model or touches the network.
 *
 * The vector derivation is the production mock's (src/embeddings.ts
 * mockEmbeddingVector), so in-process and subprocess-tier vectors agree.
 * Unlike the production mock, query and passage spaces coincide (both hash
 * the raw text) so same-text recall matches - the in-process tests rely on
 * that; the production mock applies the real query prefix.
 */
export class MockEmbeddingModel implements EmbeddingModel {
  readonly dims = 384;
  readonly name = "mock";
  loaded = true;
  #disposed = false;

  /** True after dispose() - lets tests assert shutdown wiring ran. */
  get disposed(): boolean {
    return this.#disposed;
  }

  async load(): Promise<void> {}

  async dispose(): Promise<void> {
    this.#disposed = true;
  }

  async queryEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  async passageEmbed(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  #embed(text: string): Float32Array {
    return mockEmbeddingVector(text, this.dims);
  }
}
