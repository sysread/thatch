import type { ThatchDB, DedupCandidate } from "./db";
import type { EmbeddingModel } from "./embeddings";

export const DEDUP_CLASSIFIER_PROMPT = `You are a memory deduplication classifier. You will receive two memories and decide their relationship.

Return ONLY a JSON object:
{"relationship": "duplicate" | "supplement" | "contradiction" | "unrelated",
 "action": "merge" | "update_a" | "update_b" | "keep_both" | "delete_a" | "delete_b" | "none",
 "merged_content": "..." | null,
 "explanation": "..."}

## Definitions
- duplicate: Both memories say essentially the same thing. Prefer the more detailed or better-written one.
- supplement: One memory adds useful context or detail to the other without contradicting it.
- contradiction: The memories make incompatible claims. Both should be kept but flagged.
- unrelated: Different topics entirely, despite high embedding similarity.

## Action mapping
- duplicate + merge: combine both into one memory, delete the other.
- supplement + update_a: add info from B to A's content. Keep A, delete B (or update_b for reverse).
- contradiction + keep_both: mark both as contradictions, update neither.
- unrelated + none: no changes.

## Rules
- Preserve all useful information. Don't delete facts when merging.
- Labels should remain the better of the two, or synthesize if neither is good.
- Write for a future instance with zero session context.`;

export interface DedupClassification {
  relationship: "duplicate" | "supplement" | "contradiction" | "unrelated";
  action: "merge" | "update_a" | "update_b" | "keep_both" | "delete_a" | "delete_b" | "none";
  merged_content: string | null;
  explanation: string;
}

/**
 * Handles deduplication — finding similar pairs via cosine similarity
 * and triggering classification via a background subagent.
 */
export class DedupPipeline {
  /** Finds candidates and returns them without taking action. */
  findCandidates(db: ThatchDB, stores: string[], threshold = 0.85): DedupCandidate[] {
    const candidates: DedupCandidate[] = [];
    for (const store of stores) {
      candidates.push(...db.findDuplicates(store, threshold));
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  /** Builds a prompt payload for a single candidate pair. */
  buildPayload(candidate: DedupCandidate): string {
    return JSON.stringify({
      memory_a: {
        label: candidate.labelA,
        content: candidate.contentA,
        slug: candidate.slugA,
      },
      memory_b: {
        label: candidate.labelB,
        content: candidate.contentB,
        slug: candidate.slugB,
      },
      similarity: candidate.score,
    });
  }

  /**
   * Applies a classification result to the database.
   * Handles merge, update, delete, and keep_both actions.
   */
  async applyClassification(
    db: ThatchDB,
    model: EmbeddingModel,
    store: string,
    candidate: DedupCandidate,
    classification: DedupClassification,
  ): Promise<string> {
    const { slugA, slugB, labelA, labelB, contentA, contentB } = candidate;
    let result = `${classification.relationship}`;

    switch (classification.action) {
      case "none": {
        break;
      }
      case "delete_a": {
        db.forgetEntry(store, labelA);
        result += ` → deleted "${labelA}"`;
        break;
      }
      case "delete_b": {
        db.forgetEntry(store, labelB);
        result += ` → deleted "${labelB}"`;
        break;
      }
      case "update_a":
      case "update_b":
      case "merge": {
        const content = classification.merged_content ??
          `${contentA}\n\n---\n\n${contentB}`;
        const label = classification.action === "update_b" ? labelB :
          classification.action === "update_a" ? labelA :
          labelA.length <= labelB.length ? labelA : labelB;

        const emb = await model.passageEmbed(`# ${label}\n\n${content}`);
        db.remember(store, label, `# ${label}\n\n${content}`, emb, "bge-small-en-v1.5", { overwrite: true });
        result += ` → merged into "${label}"`;

        if (classification.action === "merge") {
          db.forgetEntry(store, labelA === label ? labelB : labelA);
        }
        break;
      }
      case "keep_both": {
        result += ` → kept both, ${classification.explanation}`;
        break;
      }
    }

    return `[thatch] dedup: ${result}`;
  }
}
