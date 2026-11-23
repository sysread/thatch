/**
 * The sqlite compat layer: bun's `Database` surface implemented over
 * node:sqlite's `DatabaseSync`. This is the one module in src/ that touches
 * a sqlite driver; the seven store files import this class under the same
 * `Database` name they imported from `bun:sqlite`, and every semantic
 * difference between the two engines is absorbed HERE, once, instead of
 * spreading across ~200 call sites.
 *
 * WHY BUN-SHAPED OVER node:sqlite. The server must run under node (the
 * node-sqlite plan, docs/plans/node-sqlite-driver.md), and node:sqlite is
 * the only built-in engine every supported runtime ships: bun >= 1.4.2
 * implements node:sqlite (oven-sh/bun PR #32498), node >= 22.13.0 has it
 * unflagged. Keeping the call sites on bun's SHAPES (`run(sql, [params])`,
 * `query(sql).get()` -> null-or-row, `transaction(fn)` returning a wrapper)
 * means the seven files' ~200 call sites do not churn; the differences live
 * here where a reviewer can read them in one sitting.
 *
 * WHY NO bun:sqlite BRANCH. Opencode v1 (bun 1.3.14, which has no
 * node:sqlite at all) is dropped policy (90b352f, README.md:17); every
 * runtime this package supports resolves `node:sqlite`. A fallback branch
 * would preserve the exact coupling this change removes.
 *
 * FOUNDING INTENT, PRESERVED. The original commit chose bun:sqlite because
 * it was built-in and zero-dependency (d421be2); node:sqlite is likewise
 * built-in and zero-dependency, so the swap keeps that property. This
 * module imports nothing but `node:sqlite` - it must stay type-stripping
 * safe for node's floor (erasable syntax only: no enums, no constructor
 * parameter properties, no namespaces) so the node leg can run this source
 * directly.
 *
 * THE DELTAS THIS MODULE ABSORBS (the plan's deltas ledger):
 * - `run(sql, params)` - bun accepts an ARRAY of positional params; node
 *   would read the array as a named-parameter bag and fail with "Unknown
 *   named parameter '0'". Arrays are spread to positional.
 * - `query(sql).get()` - node returns `undefined` for a missing row where
 *   bun returns `null` (db.ts's `entryExists` does `row !== null` and would
 *   invert silently). Normalized to null.
 * - `{ readonly: true }` - node spells the option `readOnly` and SILENTLY
 *   IGNORES bun's lowercase spelling, opening read-write. Translated
 *   explicitly, always - session-db opens the host's opencode.db with the
 *   bun spelling and must never be writable.
 * - `transaction(fn)` - node has no transaction API. A depth-aware manual
 *   wrapper (below).
 * - Statement caching - node re-prepares per prepare() call where bun's
 *   `.query()` caches. A per-connection Map restores bun's shape.
 * - Busy error shape - node reports lock errors as `code: "ERR_SQLITE_ERROR"`
 *   with message "database is locked"; bun reports `code: "SQLITE_BUSY"`.
 *   The code is normalized so both busy checkers (db.ts `isBusyError`,
 *   daemon.ts `isSqliteBusy`) see bun's shape.
 * - Row objects are null-prototype under node (bun hands back plain
 *   objects). Safe for spread, JSON, and `in` checks; no site in src/
 *   calls row methods (hasOwnProperty on rows: zero sites).
 *
 * FOREIGN KEYS. node:sqlite defaults foreign_keys ON; sqlite/bun default
 * OFF. The pragma runs OFF immediately after open, before any consumer
 * pragma - db.ts then sets it ON explicitly, so every database gets the
 * constraint state its own code asks for.
 *
 * TRANSACTIONS. bun's `db.transaction(fn)` returns a zero-arg wrapper
 * function that runs fn inside a transaction when invoked; the call sites
 * use the create-and-invoke idiom (`db.transaction(() => {...})()`), so
 * this module returns the same wrapper. Nesting is depth-aware via a
 * per-connection counter (node's `database.isTransaction` does not exist
 * at the 22.13 floor): at depth 0 the wrapper runs `BEGIN` - DEFERRED,
 * matching bun's default, first-party evidence at db.ts:900-903 - then fn
 * then `COMMIT`, with `ROLLBACK` on throw; nested calls use
 * `SAVEPOINT`/`RELEASE`, with `ROLLBACK TO` + rethrow on throw so an inner
 * failure preserves the outer transaction (bun's savepoint semantics,
 * spike-verified on bun 1.4.2: inner writes roll back, the outer
 * transaction commits, the inner error rethrows).
 *
 * The depth counter assumes fn is SYNCHRONOUS - bun's contract too. An
 * async fn returns before its work runs; the bookkeeping would unwind
 * while the transaction is still open. No call site passes an async fn.
 *
 * LATENT MIXING HAZARD. The manual `exec("BEGIN IMMEDIATE")` blocks
 * (db.ts remember()/forgetEntry) bypass this counter: they hold a real
 * transaction the counter cannot see. A future `transaction()` call inside
 * those blocks would emit a nested `BEGIN` and throw "cannot start a
 * transaction within a transaction" where bun would have savepointed. No
 * such path exists today; keep it that way.
 *
 * SPIKE RESULTS (bun 1.4.2, bun:sqlite, temp dbs, 2026-11-23):
 * `typeof transaction(fn)` === "function"; default BEGIN mode DEFERRED (a
 * second connection's BEGIN IMMEDIATE succeeds inside a write-less
 * transaction(), and fails once a write ran); inner rollback preserves the
 * outer transaction and rethrows the inner error; a no-options open of a
 * missing file CREATES it (same as node - no creation-semantics delta).
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

/** The constructor options bun's call sites pass. `create` is a passthrough
 *  (both engines create missing files by default - no delta); `readonly` is
 *  translated to node's `readOnly` spelling on every open. */
export interface DatabaseOptions {
  create?: boolean;
  readonly?: boolean;
}

/** bun's run-result shape: plain numbers. node types its equivalents
 *  `number | bigint` (they widen only with the readBigInts option, which
 *  no call site uses - the deltas ledger's bigint row), so the node
 *  results are cast at the boundary and the seven files keep bun's type. */
export type StatementResult = { changes: number; lastInsertRowid: number };

/**
 * Normalizes node's sqlite error shapes to bun's. Bun surfaces sqlite's
 * native error names as the error `code` (SQLITE_BUSY, SQLITE_CONSTRAINT_*);
 * node reports `code: "ERR_SQLITE_ERROR"` and carries the sqlite meaning
 * only in the message - and the call sites' checkers read the code first
 * (db.ts `isBusyError`, the remember-path constraint catch, chat.ts
 * `#isConstraintError`), so an untranslated code falls through them. The
 * recognized lock and constraint messages get bun's code name; everything
 * else passes through untouched.
 */
function normalizeError(err: unknown): unknown {
  if (!(err instanceof Error) || (err as { code?: string }).code !== "ERR_SQLITE_ERROR") return err;
  if (/database is locked/.test(err.message)) {
    (err as { code?: string }).code = "SQLITE_BUSY";
  } else if (/constraint failed/i.test(err.message)) {
    // Bun's code carries the constraint kind as a suffix (e.g.
    // SQLITE_CONSTRAINT_UNIQUE); the checkers match on the
    // SQLITE_CONSTRAINT prefix, and the message keeps the details.
    (err as { code?: string }).code = "SQLITE_CONSTRAINT";
  }
  return err;
}

/** Bun accepted both variadic params and a single array of params; node's
 *  statements take variadic only. Normalizes the two forms to one array.
 *  A lone array is always a param list here: sqlite binds no array type,
 *  so an array reaching the engine could only be node's named-param bag. */
function flattenParams(params: unknown[]): unknown[] {
  return params.length === 1 && Array.isArray(params[0]) ? [...(params[0] as unknown[])] : params;
}

/**
 * The bun-shaped Database: one connection, the statement cache, and the
 * transaction wrapper. The type name matches bun's export so the store
 * files' `Database` annotations keep compiling unchanged.
 */
export class Database {
  #sync: DatabaseSync;
  #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(path: string, opts?: DatabaseOptions) {
    // readOnly must be set explicitly: node silently ignores bun's lowercase
    // spelling and would open read-write (spike-proven). create needs no
    // translation - both engines create missing files by default.
    this.#sync = new DatabaseSync(path, { readOnly: opts?.readonly === true });
    // node defaults foreign_keys ON; sqlite (and every consumer's
    // expectation) defaults OFF. Consumers that want constraints set the
    // pragma explicitly (db.ts does) - run this BEFORE any consumer pragma.
    this.#sync.exec("PRAGMA foreign_keys = OFF");
  }

  /** Runs one statement (DML, DDL, or pragma) with bun's array-of-params
   *  form, returning the run-result shape both engines agree on. */
  run(sql: string, params?: unknown[]): StatementResult {
    try {
      if (params === undefined) {
        return this.#sync.prepare(sql).run() as StatementResult;
      }
      return this.#sync.prepare(sql).run(...((Array.isArray(params) ? params : [params]) as never[])) as StatementResult;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** Returns a statement wrapper for sql, backed by the per-connection
   *  cache (bun's .query() caches; node re-prepares per call). No call site
   *  stores handles - all .query() chains execute immediately - so the
   *  cache only ever grows by distinct sql text and is cleared on close. */
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): StatementResult;
  } {
    let stmt = this.#statements.get(sql);
    if (stmt === undefined) {
      stmt = this.#sync.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    const cached = stmt;
    return {
      get: (...params: unknown[]) => {
        try {
          const row = cached.get(...(flattenParams(params) as never[]));
          // node returns undefined for a missing row; bun returns null and
          // the call sites lean on it (db.ts entryExists does `row !== null`).
          return row === undefined ? null : row;
        } catch (err) {
          throw normalizeError(err);
        }
      },
      all: (...params: unknown[]) => {
        try {
          return cached.all(...(flattenParams(params) as never[]));
        } catch (err) {
          throw normalizeError(err);
        }
      },
      run: (...params: unknown[]) => {
        try {
          return cached.run(...(flattenParams(params) as never[])) as StatementResult;
        } catch (err) {
          throw normalizeError(err);
        }
      },
    };
  }

  /** Executes raw SQL directly (multi-statement scripts, pragmas,
   *  BEGIN/COMMIT/ROLLBACK control statements). */
  exec(sql: string): void {
    try {
      this.#sync.exec(sql);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** bun parity: returns a zero-arg wrapper that runs fn inside a
   *  transaction when invoked (the call sites use the create-and-invoke
   *  idiom). See the module header for the depth rules and the sync-fn
   *  assumption. fn's result passes through the wrapper. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      try {
        if (this.#depth === 0) {
          this.#sync.exec("BEGIN");
          this.#depth = 1;
          try {
            const out = fn();
            this.#sync.exec("COMMIT");
            return out;
          } catch (err) {
            // The transaction failed: either fn threw inside an open
            // transaction or the COMMIT itself failed. Roll back what is
            // still rolling-back-able; a failure here means the engine
            // already unwound ("failed closed"), and masking the original
            // error with it would tell the caller nothing.
            try {
              this.#sync.exec("ROLLBACK");
            } catch {
              /* the transaction already failed closed */
            }
            throw err;
          } finally {
            this.#depth = 0;
          }
        }
        // Nested: a savepoint, not a second BEGIN. ROLLBACK TO undoes only
        // this call's work and the outer transaction survives - the
        // contract the scoring-engine's compositing comments rely on.
        const savepoint = `thatch_sp_${this.#depth}`;
        this.#sync.exec(`SAVEPOINT ${savepoint}`);
        this.#depth++;
        try {
          const out = fn();
          this.#depth--;
          this.#sync.exec(`RELEASE ${savepoint}`);
          return out;
        } catch (err) {
          this.#depth--;
          try {
            this.#sync.exec(`ROLLBACK TO ${savepoint}`);
            this.#sync.exec(`RELEASE ${savepoint}`);
          } catch {
            /* the savepoint already failed closed (an auto-rollback error
               class unwound the whole transaction) */
          }
          throw err;
        }
      } catch (err) {
        throw normalizeError(err);
      }
    };
  }

  /** Closes the connection and drops the statement cache (each reopen
   *  builds a fresh instance with a fresh cache). */
  close(): void {
    this.#statements.clear();
    this.#sync.close();
  }
}
