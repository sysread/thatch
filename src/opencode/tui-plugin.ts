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
import { isTabClosedEvent, isTabOpenedEvent, passesDirectoryGuard } from "../session-tab-shared";

export default Plugin.define({
  id: "jeffober-thatch-tui",
  setup(context) {
    const off = context.data.listen(({ details }) => {
      const windowDirectory = context.location?.directory ?? context.data.location.default().directory;
      if (!passesDirectoryGuard(details.location?.directory, windowDirectory)) return;
      if (isTabClosedEvent(details.type)) {
        // A tool-initiated close request: close the tab if THIS window has
        // one for the session. Windows that never opened it (and windows at
        // other directories, filtered above) return false - that is the
        // correct no-op, not an error. The close is reopenable by the user
        // (the strip's reopen stack), so this is tab-level, not session
        // deletion.
        const closeID = (details.data as { sessionID?: string }).sessionID;
        if (!closeID) {
          console.error("[thatch] tab-closed event without a sessionID");
          return;
        }
        if (!context.ui.tabs.close(closeID)) {
          console.error("[thatch] tab-close requested but no tab matched (or tabs are disabled)");
        }
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
