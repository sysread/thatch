// Barrel file: imports all automatable use case modules so their
// test.concurrent() calls register in this single file's test suite.
// bun --concurrent parallelizes tests within a file, not across files,
// so all use cases must be imported here for parallel execution.

import "./uc-004-cli-inspection";
import "./uc-005-setup-install";
import "./uc-008-hygiene-heartbeat";
import "./uc-009-flush-tools-tiers";
import "./uc-011-write-time-similarity-warning";
import "./uc-012-model-migration";
import "./uc-014-skill-install-drift";
import "./uc-015-env-override-matrix";
import "./uc-016-concurrent-session-isolation";
import "./uc-017-buffer-tool-vs-buffer-batch";
import "./uc-018-mcp-startup-setup-detection";
import "./uc-021-prediction-autofire";
import "./uc-022-prediction-dedup";
import "./uc-023-prediction-confidence-model";
import "./uc-024-prediction-delete";
import "./uc-025-behavior-autofire";
import "./uc-026-behavior-dedup";
import "./uc-027-behavior-confidence-model";
import "./uc-028-behavior-delete";
