/**
 * Reconstructs a Float32Array from a stored BLOB. The Uint8Array bun:sqlite
 * hands back may itself be a view, so honor its offset and length rather than
 * reading the whole backing buffer.
 */
export function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * Cosine similarity between two Float32Array vectors of equal dimension.
 * Returns a value in [-1, 1]. Normalized embeddings will be close to [0, 1].
 * Throws on dimension mismatch - comparing vectors from different embedding
 * spaces is always a caller bug; callers filter by length first.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}
