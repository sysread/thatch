/**
 * Read one runtime_state journal row from a thatch database, read-only.
 *
 * The v2-adapter tests and QA use cases use journal rows as deterministic
 * resolution observables (a branch that deletes its row has run to
 * completion - the same idiom in three call sites before this helper).
 * Returns the row's JSON-parsed value, or null when no row exists - the
 * boolean sites test `!== null`, the value sites cast the result.
 *
 * Contract: null means NO ROW EXISTS. A writer that journals the JSON
 * literal null (or any falsy value a boolean site tests with !== null)
 * would be indistinguishable from row-gone here - writers must route
 * cleared state through runtimeStateDelete, never a null value (every
 * current writer does: undefined values delete the row instead).
 */

import { Database } from "bun:sqlite";

export function runtimeStateRow(dbPath: string, kind: string, sessionID: string): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM runtime_state WHERE kind = ? AND session_id = ?").get(kind, sessionID) as
      | { value: string }
      | null;
    return row ? JSON.parse(row.value) : null;
  } finally {
    db.close();
  }
}
