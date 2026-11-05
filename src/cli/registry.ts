/**
 * The top-level subcommand registry. The dispatcher resolves the first
 * CLI token against this list; listing order here is help order.
 */
import type { Subcommand } from "./types";
import { stores, list, show, forget, search, remember } from "./commands/memory";
import { mcp, reminder, hygiene, prime } from "./commands/misc";
import { setup } from "./commands/setup";
import { bufferBatch, bufferTool, flushTools, chatNotify, flushPredictions } from "./commands/hook-commands";
import { session } from "./commands/session";
import { chat } from "./commands/chat";

export const REGISTRY: Subcommand[] = [stores, list, show, forget, search, remember, mcp, reminder, hygiene, prime, bufferBatch, bufferTool, flushTools, chatNotify, flushPredictions, setup, session, chat];
