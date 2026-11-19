/**
 * One stdio JSON-RPC client for the spawned-MCP-server tests: boots
 * `bin/thatch mcp` as a subprocess and answers requests with a per-request
 * deadline. THE one copy - four files grew their own (two without the
 * deadline or cleanup a wedged spawned server needs) before this
 * extraction; new tests import this one.
 *
 * Failures surface through `report` when given (QA use cases accumulate
 * failures and keep going) or by throwing when not (unit tests).
 */

export interface StdioJsonRpcClient {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, any>>;
  close: () => Promise<void>;
}

export function bootStdioJsonRpcClient(
  argv: string[],
  env: Record<string, string>,
  opts: { report?: (message: string) => void; requestTimeoutMs?: number } = {},
): StdioJsonRpcClient {
  const fail = (message: string): Record<string, any> => {
    if (opts.report) {
      opts.report(message);
      return {};
    }
    throw new Error(message);
  };
  const proc = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idSeq = 1;

  const request = async (method: string, params: Record<string, unknown> = {}, timeoutMs = opts.requestTimeoutMs ?? 20_000): Promise<Record<string, any>> => {
    const id = idSeq++;
    proc.stdin.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    proc.stdin.flush();
    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<Record<string, any>> => {
      if (Date.now() > deadline) {
        reader.cancel().catch(() => {});
        return fail(`timeout waiting for ${method} (id ${id})`);
      }
      const { value, done } = await reader.read();
      if (done) return fail(`server closed before answering ${method} (id ${id})`);
      buf += dec.decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) return msg;
        } catch {
          // not JSON - skip
        }
      }
      return poll();
    };
    return poll();
  };

  return {
    proc,
    request,
    close: async () => {
      reader.cancel().catch(() => {});
      // Close stdin so a server that exits on stdin close can; then kill
      // whatever remains and wait for the exit code.
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      proc.kill();
      await proc.exited;
    },
  };
}
