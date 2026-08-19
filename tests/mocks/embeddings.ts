import type { EmbeddingModel } from "../../src/embeddings";

/**
 * Mock embedding model for tests. Returns deterministic vectors derived from
 * a hash of the input text via xorshift, so identical texts embed identically
 * and distinct texts land near-orthogonal - mirroring how unrelated content
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
