# UC-016: Concurrent session isolation

**Preconditions**
- Two opencode sessions in the same repo (A and B)
- (Separately) two Claude Code / Cursor hook processes with different session IDs

**Steps**

**opencode (in-memory buffer)**
1. In session A, run a non-thatch tool (the extraction ring buffer records it).
2. In session B, send a message — `chat.message` runs.
3. In session A, send a message — `chat.message` runs.

**Claude Code / Cursor (file-backed queue)**
4. Hook process for session A calls `buffer-tool`/`buffer-batch`.
5. Hook process for session B calls `buffer-tool`/`buffer-batch`.
6. `flush-tools` is invoked for session A, then for session B.

**Sideband (shared warm model)**
7. Both sessions' `flush-tools` connect to the same sideband socket.

**Expected**
- **No cross-session bleed** in either path: session B's `chat.message` produces
  no nudge from session A's buffered interaction; session B's message only sees
  its own buffer. The in-memory `ExtractionPipeline` and the file-backed queue are
  both keyed by session ID.
- `flush-tools` for session A peeks only A's queue file (does not delete it); a
  second flush for A returns the same content with an escalated missed-nudge
  counter (the queue persists until a memory write or `extraction_done`). Session
  B's queue file is untouched and is peeked on its own flush.
- The sideband socket is **shared** (one warm MCP server) but **stateless per
  query**: each request embeds a fresh prompt and returns its own matches. Two
  concurrent match requests do not interfere.

_Automatable: yes — `extraction.test.ts` (in-memory per-session) and
`extract-queue.test.ts` (file-backed per-session) already cover isolation; the
sideband is a stateless request/response so concurrency is trivially safe._
