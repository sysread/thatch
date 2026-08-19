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
import "./uc-038-no-save-run";
import "./uc-043-compaction-suppression";
import "./uc-077-child-session-drain";
import "./uc-078-child-session-error";
import "./uc-079-child-session-deletion";
import "./uc-080-parent-session-deletion";
import "./uc-083-review-coordinator";
import "./uc-084-review-walkthrough";
import "./uc-085-review-followup";
import "./uc-086-review-response";
import "./uc-087-review-no-subagents";
