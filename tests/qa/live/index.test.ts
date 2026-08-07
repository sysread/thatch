// Barrel file: imports all live-session use case modules so their
// test.concurrent() calls register in this single file's test suite.
// bun --concurrent parallelizes tests within a file, not across files,
// so all use cases must be imported here for parallel execution.

import "./uc-001-memory-roundtrip";
import "./uc-002-dedup-cycle";
import "./uc-003-extraction-nudge";
import "./uc-006-cursor-hook-lifecycle";
import "./uc-007-recall-nudge";
import "./uc-010-prime";
import "./uc-013-compaction-context";
import "./uc-019-archived-memory-lifecycle";
import "./uc-020-extraction-escalation";
