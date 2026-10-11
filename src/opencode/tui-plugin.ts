// The session-tab TUI CLI plugin: the TUI-side half of the session-tab
// feature (docs/dev/features/session-tabs.md). Loaded by the opencode v2 TUI
// from the package's ./tui entrypoint; runs once per TUI window, next to the
// tab primitives it drives.
//
// The server-side adapter cannot reach the tab strip - the v2 plugin event
// domain is subscribe-only and the HTTP surface has no publish route - so
// the flow crosses processes over an rpc event: the adapter emits
// rpc.thatch-tabs.tab-opened (sessionID + the coordinator instance's
// directory), the SSE feed fans it to every window, and THIS plugin acts on
// it with ui.tabs.open. The guard mirrors the built-in tui.* handlers
// (packages/tui/src/app.tsx): an event only acts on the window whose
// directory matches the event's location. ui.tabs.open is idempotent and
// never steals focus, so no dedupe state is kept - a hot reload re-runs
// setup from fresh state and double events are no-ops.
//
// ISOLATION: this module must only be imported by the TUI process - tests
// import the pure filter/guard logic from src/session-tab-shared.ts, never
// this file (the tui entrypoint imports solid-js, an uninstalled optional
// peer).

import { Plugin } from "@opencode/plugin/tui";
import { isExitTabClosedEvent, isTabClosedEvent, isTabOpenedEvent, isToastEvent, passesDirectoryGuard } from "../session-tab-shared";

export default Plugin.define({
  id: "jeffober-thatch-tui",
  setup(context) {
    const off = context.data.listen(({ details }) => {
      const windowDirectory = context.location?.directory ?? context.data.location.default().directory;
      if (!passesDirectoryGuard(details.location?.directory, windowDirectory)) return;
      // Two close events, one TUI action: tab-closed (the session_tab_close
      // tool's confirmed close - the pump also runs its death bookkeeping)
      // and exit-tab-closed (the wrap-up exit's close - the runtime records
      // the deaths itself before emitting, so the pump ignores that one).
      if (isTabClosedEvent(details.type) || isExitTabClosedEvent(details.type)) {
        // Close the tab if THIS window has one for the session. Windows that
        // never opened it (and windows at other directories, filtered above)
        // return false - that is the correct no-op, not an error. The close
        // is reopenable by the user (the strip's reopen stack), so this is
        // tab-level, not session deletion.
        const closeID = (details.data as { sessionID?: string }).sessionID;
        if (!closeID) {
          console.error("[thatch] tab-close event without a sessionID");
          return;
        }
        if (!context.ui.tabs.close(closeID)) {
          console.error("[thatch] tab-close requested but no tab matched (or tabs are disabled)");
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
