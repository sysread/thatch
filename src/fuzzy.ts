/**
 * Git-style "Did you mean" suggestions for tool error paths.
 *
 * Pure functions - no IO, no db access. Callers hand in the candidate list
 * (memory labels, chat names, config keys) and render the returned strings
 * into their error text.
 *
 * The edit distance is the restricted Damerau-Levenshtein (optimal string
 * alignment) with git's empirically-derived weights, chosen at git's
 * help.c call site as levenshtein(cmd, candidate, 0, 2, 1, 3): a
 * transposition of two adjacent characters is FREE (the dominant typo,
 * e.g. stauts -> status), a substitution costs 2, an insertion 1, a
 * deletion 3.
 *
 * Suggestions are git-strict: when nothing scores under the threshold the
 * result is empty. A far-off input never gets a fallback guess - a wrong
 * suggestion teaches the caller to trust the wrong thing.
 */

/** Cost of an adjacent-character transposition (stauts -> status is free). */
const SWAP_COST = 0;
/** Cost of replacing one character with another. */
const SUB_COST = 2;
/** Cost of adding a character (the candidate has a character the query lacks). */
const INSERT_COST = 1;
/** Cost of removing a character (the query has a character the candidate lacks). */
const DELETE_COST = 3;

/**
 * Restricted Damerau-Levenshtein distance (optimal string alignment):
 * adjacent transpositions count, but a substring cannot be transposed
 * twice. O(len(a) * len(b)) time, linear memory in the second operand
 * (three rolling integer rows of len(b)+1 - the transposition case needs
 * the row before last).
 */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length * INSERT_COST;
  if (b.length === 0) return a.length * DELETE_COST;

  // Rows i-2, i-1, and i of the DP matrix; only these three are ever read.
  let prev2: number[] = [];
  let prev1: number[] = [];
  let row: number[] = [];

  for (let j = 0; j <= b.length; j++) prev1[j] = j * INSERT_COST;

  for (let i = 1; i <= a.length; i++) {
    row = [i * DELETE_COST];
    for (let j = 1; j <= b.length; j++) {
      const sub = prev1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : SUB_COST);
      let best = Math.min(
        row[j - 1] + INSERT_COST, // insert into a
        prev1[j] + DELETE_COST, // delete from a
        sub,
      );
      // git's levenshtein.c allows the swap even when the two characters
      // of a are equal; that case is a no-op here because the substitution
      // path already aligns equal characters at cost 0, so the guard just
      // blocks the phantom swap branch.
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1] &&
        a[i - 1] !== a[i - 2]
      ) {
        best = Math.min(best, prev2[j - 2] + SWAP_COST);
      }
      row[j] = best;
    }
    prev2 = prev1;
    prev1 = row;
  }
  return row[b.length];
}

/** Splits a label into lowercase word tokens on any non-alphanumeric run. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Scores one candidate against the query. The direct distance handles
 * short single-word labels; the token-aware score handles multi-word
 * labels, where the whole-string distance stays large even when only one
 * word differs. Each query token costs its cheapest distance to any
 * candidate token; each candidate token beyond the query's token count
 * costs one insertion.
 */
function scoreCandidate(query: string, candidate: string): number {
  const direct = damerauLevenshtein(query, candidate);
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.length <= 1 && candidateTokens.length <= 1) return direct;

  let tokenScore = 0;
  for (const qt of queryTokens) {
    let best = Infinity;
    for (const ct of candidateTokens) {
      const d = damerauLevenshtein(qt, ct);
      if (d < best) best = d;
    }
    if (best === Infinity) {
      // Candidate has no tokens at all (empty/separator-only label).
      best = qt.length * DELETE_COST;
    }
    tokenScore += best;
  }
  const extraCandidateTokens = Math.max(0, candidateTokens.length - queryTokens.length);
  tokenScore += extraCandidateTokens * INSERT_COST;
  return Math.min(direct, tokenScore);
}

/**
 * The suggestion threshold, scaled to the query length so long labels are
 * not defeated by an absolute cap: a 60-character label tolerates more
 * absolute edit distance than a 6-character one. At the floor of 4, the
 * costliest single edit (a deletion, 3) still suggests, and cheap pairs
 * can suggest, but any candidate scoring 4 or more never does.
 */
function cutoffFor(query: string): number {
  return Math.max(4, Math.ceil(0.4 * query.trim().length));
}

/**
 * Returns the candidates close enough to the query to suggest, best first
 * (ties keep the caller's order), capped at 3. Empty when nothing is
 * close - callers render no suggestion line at all rather than guessing.
 */
export function didYouMean(query: string, candidates: readonly string[]): string[] {
  const cutoff = cutoffFor(query);
  const scored: { candidate: string; score: number }[] = [];
  for (const candidate of candidates) {
    // The exact string is never suggested: callers arrive here because a
    // lookup on it already failed.
    if (candidate === query) continue;
    const score = scoreCandidate(query, candidate);
    if (score < cutoff) scored.push({ candidate, score });
  }
  // Stable ascending sort: equal scores keep the candidate list's order.
  return scored
    .sort((x, y) => x.score - y.score)
    .slice(0, 3)
    .map((s) => s.candidate);
}

/**
 * Renders the suggestion sentence for an error message, one candidate or
 * several. The plural form is git's verbatim ("Did you mean one of
 * these?"); the singular is git-style rather than git's verbatim ("The
 * most similar command is"). Empty string when didYouMean found nothing,
 * so callers can append the line unconditionally.
 */
export function didYouMeanLine(query: string, candidates: readonly string[]): string {
  const hits = didYouMean(query, candidates);
  if (hits.length === 0) return "";
  const quoted = hits.map((h) => `"${h}"`);
  if (quoted.length === 1) return `Did you mean ${quoted[0]}?`;
  return `Did you mean one of these: ${quoted.join(", ")}?`;
}

/**
 * Appends the suggestion sentence for a miss to an error message. Empty
 * candidates or nothing close leaves the message untouched: a far-off
 * input gets no fallback guess, so the caller is never taught to trust a
 * wrong suggestion.
 */
export function withDidYouMean(message: string, query: string, candidates: readonly string[]): string {
  const line = didYouMeanLine(query, candidates);
  return line ? `${message}\n${line}` : message;
}

/**
 * Finds a near-miss parameter name in a raw argument object: a key outside
 * `expected` whose string value exists but whose name is a plausible
 * misspelling of one of the expected names. Used by the accept-then-teach
 * guards to say "you passed 'labels'; did you mean 'label'?" instead of a
 * bare "No label provided". Returns only the misnamed KEY (null when
 * nothing is near); the caller may read its value from the args object,
 * but the teach-only contract forbids APPLYING it.
 */
export function nearMissParam(args: Record<string, unknown>, expected: readonly string[]): string | null {
  for (const key of Object.keys(args)) {
    if (expected.includes(key)) continue;
    const value = args[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (didYouMean(key, expected).length > 0) return key;
  }
  return null;
}
