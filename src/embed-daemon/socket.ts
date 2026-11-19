/**
 * The one socket-dial primitive for the embed-daemon family: the bun
 * ordering rule is stated HERE and nowhere else. The error and connect
 * handlers attach BEFORE the dial, because bun can surface a connect
 * failure (ENOENT on a stale socket path) synchronously, and a listener
 * attached after connect() would miss it
 * (docs/dev/gotchas.md, "bun delivers server listen callbacks late and
 * connect errors early").
 *
 * Resolves with the connected socket; the caller owns it from there
 * (protocol wiring and destroy).
 */
import { Socket } from "node:net";

export function dialSocket(socketPath: string, timeoutMs?: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = timeoutMs
      ? setTimeout(() => {
          socket.destroy();
          reject(new Error(`connect to ${socketPath} timed out`));
        }, timeoutMs)
      : null;
    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
    socket.once("connect", () => {
      if (timer) clearTimeout(timer);
      resolve(socket);
    });
    socket.connect(socketPath);
  });
}
