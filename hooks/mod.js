// src/claude-plugin/mod.ts
var WRAPUP_KINDS = ["compact", "exit"];
function readLifecycleResult(res) {
  const asResult = (obj) => {
    if (typeof obj?.text !== "string")
      return null;
    const w = obj.wrapup;
    if (w === "compact" || w === "exit")
      return { text: obj.text, wrapup: w };
    try {
      const inner = JSON.parse(obj.text);
      const innerResult = asResult(inner);
      if (innerResult)
        return innerResult;
    } catch {}
    return { text: obj.text };
  };
  if (Array.isArray(res)) {
    try {
      return asResult(JSON.parse(readStageText(res))) ?? { text: readStageText(res) };
    } catch {
      return { text: readStageText(res) };
    }
  }
  if (typeof res === "string") {
    try {
      return asResult(JSON.parse(res)) ?? { text: res };
    } catch {
      return { text: res };
    }
  }
  const obj = res ?? {};
  if (obj.result !== undefined)
    return readLifecycleResult(obj.result);
  return asResult(obj) ?? { text: "" };
}
function readStageText(res) {
  if (typeof res === "string")
    return res;
  if (res == null)
    return "";
  if (Array.isArray(res)) {
    return res.map((b) => typeof b === "object" && b !== null && ("text" in b) ? String(b.text) : "").join("");
  }
  const obj = res;
  for (const key of ["text", "result"]) {
    const v = obj[key];
    if (typeof v === "string")
      return v;
  }
  if (Array.isArray(obj.content))
    return readStageText(obj.content);
  return "";
}
var bundledServerName = null;
var failureLines = [];
function recordFailure($, kind, err) {
  const reason = err instanceof Error ? err.message : String(err);
  failureLines.push(`${new Date().toISOString()} ${kind}: ${reason}`);
  if (failureLines.length > 20)
    failureLines.splice(0, failureLines.length - 20);
  try {
    $.ui.log(`[thatch] ${kind}: ${reason}`);
  } catch {}
  $.fs.write(`${$.plugin.root}/mod-failures.log`, failureLines.join(`
`)).catch(() => {});
}
async function callBundledServer($, options, tool, args) {
  if (!bundledServerName) {
    const conn = await $.mcp.connect(options.serverKey);
    if (!conn.isConnected || !conn.server) {
      throw new Error(`the bundled server is not connected: ${conn.message ?? conn.reason ?? "unknown"}`);
    }
    bundledServerName = conn.server;
  }
  return $.mcp.call(bundledServerName, tool, args);
}
function registerMod(on, options) {
  let wakeInFlight = false;
  let pendingWake = null;
  let wakeTimer = null;
  on("prompt.submit", async ($, e, next) => {
    let stageText = "";
    try {
      const sessionId = await $.session.id();
      const res = await callBundledServer($, options, options.stageTool, { prompt: e.text ?? "", session_id: sessionId, ...e.transcript_path ? { transcript_path: e.transcript_path } : {} });
      stageText = readStageText(res);
    } catch (err) {
      recordFailure($, "the stage call failed; prompts proceed without thatch context", err);
      return next(e);
    }
    if (!stageText.trim())
      return next(e);
    return next({ ...e, context: [...e.context ?? [], stageText] });
  });
  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await forwardLifecycle($, options, { event: "busy", wake: wakeInFlight });
      } catch {} finally {
        wakeInFlight = false;
      }
    }
    return next(e);
  });
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    const resultText = typeof result === "string" ? result : result?.result ?? result?.text ?? "";
    try {
      await forwardLifecycle($, options, {
        event: "realwork",
        tool: e.tool,
        tool_input: toolArgsOf(e),
        tool_response: typeof resultText === "string" ? resultText.slice(0, 2000) : JSON.stringify(resultText).slice(0, 2000),
        is_main: e.agentId === undefined
      });
    } catch {}
    return result;
  });
  on("turn.complete", async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        if (pendingWake !== null) {
          const text = pendingWake;
          try {
            const res = await $.prompt.submit({ text });
            if (res?.drop) {
              pendingWake = text;
            } else {
              pendingWake = null;
              wakeInFlight = true;
            }
          } catch {
            pendingWake = text;
          }
        }
        const res = await forwardLifecycle($, options, { event: "complete", is_aborted: e.isAborted === true });
        if (res.wrapup === "compact") {
          await $.session.compact();
        } else if (res.wrapup === "exit") {
          await $.ui.notify("Thatch wrap-up complete - it is safe to close this session.");
        }
      }
    } catch {}
    return next(e);
  });
  on("classic.PermissionRequest", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "ask",
        kind: "permission",
        request_id: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined
      });
    } catch {}
    return next(e);
  });
  on("classic.PermissionDenied", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "resolved",
        request_id: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined
      });
    } catch {}
    return next(e);
  });
  on("classic.StopFailure", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "error",
        error: typeof e.error === "string" ? e.error : typeof e.kind === "string" ? e.kind : "ProviderError"
      });
    } catch {}
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    const reason = String(e?.reason ?? "other");
    if (reason !== "clear" && reason !== "resume" && reason !== "branch") {
      try {
        await forwardLifecycle($, options, { event: "session-end" });
      } catch (err) {
        recordFailure($, "the session-end forward failed; watcher cleanup did not run", err);
      }
    }
    return next(e);
  });
  on("session.start", async ($, e, next) => {
    try {
      for (const kind of WRAPUP_KINDS) {
        await $.tool.register({
          name: kind,
          description: `Greenlight the ${kind} wrap-up (the user armed it with /thatch_${kind}). Call when the checklist is done.`,
          inputSchema: { type: "object", properties: {} }
        });
      }
      for (const kind of WRAPUP_KINDS) {
        await $.command.register({
          name: `thatch_${kind}`,
          description: kind === "compact" ? "Arm the compact wrap-up: run your closing checklist, then call the compact tool." : "Arm the exit wrap-up: run your closing checklist, then call the exit tool."
        });
      }
    } catch {}
    wakeTimer?.cancel();
    const pollWake = async () => {
      let sessionId;
      try {
        sessionId = await $.session.id();
      } catch {
        return;
      }
      let wakeText = "";
      try {
        wakeText = readStageText(await callBundledServer($, options, options.chatWakeTool, { session_id: sessionId }));
      } catch (err) {
        recordFailure($, "the chat-wake poll failed", err);
      }
      let watchRes = "";
      try {
        watchRes = readStageText(await callBundledServer($, options, options.watchPollTool, { session_id: sessionId }));
      } catch (err) {
        recordFailure($, "the watcher poll failed", err);
      }
      const text = [wakeText, watchRes].filter((t) => t.trim()).join(`

`);
      if (!text.trim())
        return;
      try {
        const res = await $.prompt.submit({ text });
        if (res?.drop) {
          pendingWake = text;
        } else {
          pendingWake = null;
          wakeInFlight = true;
        }
      } catch {
        pendingWake = text;
      }
    };
    wakeTimer = $.clock.every(options.wakePollMs ?? 30000, pollWake);
    return next(e);
  });
  on("command.run", { command: "thatch_compact" }, async ($) => {
    return await armWrapup($, options, "compact");
  });
  on("command.run", { command: "thatch_exit" }, async ($) => {
    return await armWrapup($, options, "exit");
  });
  on("tool.call", { tool: "mcp__thatch__compact" }, async ($) => {
    return await greenlightWrapup($, options, "compact");
  });
  on("tool.call", { tool: "mcp__thatch__exit" }, async ($) => {
    return await greenlightWrapup($, options, "exit");
  });
}
async function forwardLifecycle($, options, args) {
  const sessionId = await $.session.id();
  const res = await callBundledServer($, options, options.lifecycleTool, { ...args, session_id: sessionId });
  return readLifecycleResult(res);
}
function toolArgsOf(e) {
  const args = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === "tool" || k === "agentId" || k === "session_id")
      continue;
    args[k] = v;
  }
  return args;
}
async function armWrapup($, options, kind) {
  try {
    const res = await forwardLifecycle($, options, { event: "arm", kind });
    return { text: res.text };
  } catch {
    return { text: `[thatch] the ${kind} wrap-up could not be armed (the bundled server is unreachable). Nothing was armed.` };
  }
}
async function greenlightWrapup($, options, kind) {
  let teach;
  try {
    const res = await forwardLifecycle($, options, { event: "greenlight", kind });
    teach = res.text;
  } catch {
    teach = "[thatch] the wrap-up greenlight could not reach the bundled server; the wrap-up will not fire.";
  }
  return { result: { content: [{ type: "text", text: teach }], isError: false } };
}
export {
  readStageText,
  registerMod
};
