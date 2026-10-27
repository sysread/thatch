// The session-tab TUI CLI plugin: the TUI-side half of the session-tab
// feature (docs/dev/features/session-tabs.md). Loaded by the opencode v2 TUI
// from the package's ./tui entrypoint; runs once per TUI window, next to the
// tab primitives it drives.
//
// The server-side adapter cannot reach the tab strip - the v2 plugin event
// domain is subscribe-only and the HTTP surface has no publish route - so
// the flow crosses processes over an rpc event: the adapter emits
// rpc.thatch-tabs.tab-opened (sessionID + the subordinate's final directory
// + the coordinator's session id), the SSE feed fans it to every window,
// and THIS plugin acts on it with ui.tabs.open. Routing (actsOnTabEvent in
// src/session-tab-shared.ts): open events anchor on the coordinator - a
// window holding the coordinator's tab acts, else the window whose default
// directory (its own cwd) matches the event's location; toast events act
// only in the window whose VIEWED directory (the session on screen) matches
// the event's location (the same guard the built-in tui.* handlers apply);
// close events act session-scoped with no directory guard - a session that
// moved after its tab was opened stamps its close with the new directory
// while the tab lives in the original window. ui.tabs.open is idempotent and
// never steals focus, so no dedupe state is kept - a hot reload re-runs
// setup from fresh state and double events are no-ops.
//
// ISOLATION: this module must only be imported by the TUI process - tests
// import the pure filter/guard logic from src/session-tab-shared.ts, never
// this file (the tui entrypoint imports solid-js, an uninstalled optional
// peer).

import { Plugin } from "@opencode/plugin/tui";
import type { SessionMessageInfo } from "@opencode/client";
import { actsOnTabEvent, isExitTabClosedEvent, isTabClosedEvent, isTabOpenedEvent, isToastEvent } from "../session-tab-shared";
import { redoLastMessage, walkMessages, type RedoMessage } from "../redo-shared";

/** The client message union flattened to the orchestration's narrow shape. */
function toRedoMessage(message: SessionMessageInfo): RedoMessage {
  return {
    id: message.id,
    type: message.type,
    text: "text" in message ? message.text : undefined,
    created: message.time.created,
  };
}

export default Plugin.define({
  id: "jeffober-thatch-tui",
  setup(context) {
    // The /s redo command (docs/dev/features/opencode-plugin.md): undo the
    // last exchange and resubmit the message with a perl-style substitution
    // applied. arguments: true passes the raw substitution as run's input;
    // the space after /s is load bearing (the host splits the command name
    // at the first whitespace, so /s/foo/bar never reaches this command).
    // mode: "global" so the command exists regardless of the focused
    // renderable - it acts on the VIEWED session like /undo does.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "thatch.redo",
          title: "Redo with substitution",
          description: "Undo the last exchange and resubmit your message with s/PAT/REPL/flags applied",
          group: "Session",
          slash: { name: "s", arguments: true },
          run(input) {
            const route = context.ui.router.current();
            if (route.type !== "session") {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" });
              return;
            }
            const sessionID = route.sessionID;
            const client = context.client;
            void redoLastMessage(
              {
                // History walk over the client's paged message.list - the
                // data layer's message list is a newest-20 window, not
                // history, and a routine turn pushes the target out of it.
                fetchMessages: (sid) =>
                  walkMessages((page) =>
                    client
                      .message.list({ sessionID: sid, limit: page.limit, order: page.order, cursor: page.cursor })
                      .then((result) => ({ data: result.data.map(toRedoMessage), cursor: result.cursor })),
                  ),
                // The staged-revert state the built-in /redo's enabled
                // check reads, via the plugin data layer.
                stagedRevertMessageID: async (sid) => context.data.session.get(sid)?.revert?.messageID,
                pendingInboxCount: async (sid) => context.data.session.pending.list(sid).length,
                // The /undo trio's first two steps (routes/session/index.tsx).
                interruptAndWait: async (sid) => {
                  await client.session.interrupt({ sessionID: sid });
                  await client.session.wait({ sessionID: sid });
                },
                revertStage: async (sid, messageID) => {
                  await client.session.revert.stage({ sessionID: sid, messageID });
                },
                resubmit: async (sid, text) => {
                  await client.session.prompt({ sessionID: sid, text });
                },
              },
              sessionID,
              input ?? "",
            )
              .then((outcome) => {
                context.ui.toast.show({
                  message: outcome.message,
                  variant: outcome.ok ? "success" : outcome.variant,
                });
              })
              .catch((error) => {
                context.ui.toast.show({
                  message: `redo failed: ${error instanceof Error ? error.message : String(error)}`,
                  variant: "error",
                });
              });
          },
        },
      ],
    }));
    const off = context.data.listen(({ details }) => {
      // Two directory identities per window: the VIEWED session's directory
      // (the location context follows navigation) and the window's own cwd
      // (the default directory - the one the tab strip keys its tabs by).
      // The guard routes opens by the coordinator's tab first, then the
      // default directory; toasts keep the viewed-directory guard. See
      // actsOnTabEvent.
      const defaultDirectory = context.data.location.default().directory;
      const viewedDirectory = context.location?.directory ?? defaultDirectory;
      const payload = details.data as { coordinatorSessionID?: string | null };
      // The strip holds ROOT session ids, and the coordinator could itself
      // be a child session (a subordinate that coordinates) - compare roots.
      // root() on an id this window never synced is unspecified; failure
      // degrades to the directory fallback, never kills the listener.
      const coordinatorSessionID = payload.coordinatorSessionID ?? null;
      let windowHoldsCoordinatorTab = false;
      if (coordinatorSessionID !== null) {
        try {
          windowHoldsCoordinatorTab = context.ui.tabs
            .list()
            .some((tab) => tab.sessionID === context.data.session.root(coordinatorSessionID));
        } catch {}
      }
      if (!actsOnTabEvent({
        type: details.type,
        eventDirectory: details.location?.directory,
        viewedDirectory,
        defaultDirectory,
        windowHoldsCoordinatorTab,
      })) return;
      // Two close events, one TUI action: tab-closed (the session_tab_close
      // tool's confirmed close - the pump also runs its death bookkeeping)
      // and exit-tab-closed (the wrap-up exit's close - the runtime records
      // the deaths itself before emitting, so the pump ignores that one).
      if (isTabClosedEvent(details.type) || isExitTabClosedEvent(details.type)) {
        // Close the tab if THIS window has one for the session. Windows that
        // never opened it are the expected majority now that close events
        // act session-scoped (no directory guard) - a silent no-op there.
        // A window HOLDING the tab whose close fails means session tabs got
        // disabled mid-session. The close is reopenable by the user (the
        // strip's reopen stack), so this is tab-level, not session deletion.
        const closeID = (details.data as { sessionID?: string }).sessionID;
        if (!closeID) {
          console.error("[thatch] tab-close event without a sessionID");
          return;
        }
        if (!context.ui.tabs.list().some((tab) => tab.sessionID === closeID)) return;
        if (!context.ui.tabs.close(closeID)) {
          console.error("[thatch] tab-close failed for a held tab (session tabs disabled mid-session?)");
        }
        return;
      }
      // The toast request: the server-side runtime's only TUI feedback
      // channel (alerts, extraction metrics, chat registration, blocked
      // wrap-ups). Best-effort like every toast - the event is ephemeral,
      // so a TUI that is absent simply never shows it.
      if (isToastEvent(details.type)) {
        const toast = details.data as { message?: string; variant?: string; duration?: number };
        if (typeof toast.message !== "string") {
          console.error("[thatch] toast event without a message");
          return;
        }
        context.ui.toast.show({
          message: toast.message,
          variant: (toast.variant as "info" | "success" | "warning" | "error") ?? "info",
          duration: typeof toast.duration === "number" ? toast.duration : undefined,
        });
        return;
      }
      if (!isTabOpenedEvent(details.type)) return;
      const sessionID = (details.data as { sessionID?: string }).sessionID;
      if (!sessionID) {
        console.error("[thatch] tab-opened event without a sessionID");
        return;
      }
      // Sync the session into the TUI's cache before opening: the strip
      // renders the session's real title instead of the new-session
      // fallback.
      void context.data.session
        .sync(sessionID)
        .catch(() => {})
        .then(() => {
          if (!context.ui.tabs.open(sessionID)) {
            console.error("[thatch] tab-open requested but session tabs are disabled in this window");
          }
        });
    });
    // The unsubscribe IS the cleanup: without it every plugin hot reload
    // leaks another listener.
    return off;
  },
});
