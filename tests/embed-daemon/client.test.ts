import { describe, test, expect, beforeEach } from "bun:test";
import { RemoteEmbeddingModel, type DaemonConnection, type Transport } from "../../src/embed-daemon/client";
import type { DaemonResponse, HelloResponse } from "../../src/embed-daemon/protocol";
import type { EmbeddingModel } from "../../src/embeddings";

// The client unit tier: an in-memory transport, every dependency injected.
// The policy branches tested here mirror docs/plans/embedding-daemon.md's
// client state matrix.

let notes: string[];
const VERSION = "0.4.3";

/** A scripted in-memory connection: the test supplies the responses. */
class FakeConnection implements DaemonConnection {
  constructor(
    private daemon: FakeDaemon,
    public id: number,
  ) {}
  hello(): Promise<DaemonResponse> {
    return this.daemon.handle("hello");
  }
  embed(kind: "query" | "passage", _text: string): Promise<DaemonResponse> {
    return this.daemon.handle(`embed:${kind}`);
  }
  close(): void {
    this.daemon.closed += 1;
  }
}

/** The in-memory daemon behind the transport. Behavior knobs per test. */
class FakeDaemon {
  connections = 0;
  closed = 0;
  helloModel = "mock";
  helloError: string | null = null;
  embedError: string | null = null;
  wedgeHello = false;
  wedgeEmbed = false;
  // Mid-life death: the socket is GONE (connect fails, nothing answers).
  dead = false;
  vector: number[] = [1, 2, 3];
  #seq = 0;

  handle(op: string): Promise<DaemonResponse> {
    this.connections += 1;
    if (op === "hello") {
      if (this.wedgeHello) return new Promise(() => {});
      if (this.helloError) return Promise.resolve({ ok: false, error: this.helloError });
      const res: HelloResponse = { ok: true, model: this.helloModel, version: VERSION, pid: 4242 };
      return Promise.resolve(res);
    }
    if (this.wedgeEmbed) return new Promise(() => {});
    if (this.embedError) return Promise.resolve({ ok: false, error: this.embedError });
    return Promise.resolve({ ok: true, vector: this.vector, model: this.helloModel, version: VERSION, pid: 4242 });
  }

  transport(): Transport {
    return async () => {
      if (this.dead) throw new Error("connect failed (ENOENT)");
      return new FakeConnection(this, this.#seq++);
    };
  }
}

/** The local fallback's spy: distinct vectors, load/dispose counters. */
class LocalModel implements EmbeddingModel {
  loads = 0;
  disposed = 0;
  loaded = false;
  name = "mock";
  async load(): Promise<void> {
    this.loads += 1;
    this.loaded = true;
  }
  async queryEmbed(_text: string): Promise<Float32Array> {
    return Float32Array.from([7, 7, 7]);
  }
  async passageEmbed(_text: string): Promise<Float32Array> {
    return Float32Array.from([8, 8, 8]);
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

interface BuildOpts {
  daemon?: FakeDaemon;
  local?: LocalModel;
  transport?: Transport;
  ensureDaemonRunning?: () => Promise<"running" | "failed">;
  requestTimeoutMs?: number;
  cooldownMs?: number;
}

function build(opts: BuildOpts = {}) {
  notes = [];
  const daemon = opts.daemon ?? new FakeDaemon();
  const local = opts.local ?? new LocalModel();
  let factoryCalls = 0;
  const now = { value: 1_000_000 };
  const model = new RemoteEmbeddingModel({
    dbPath: "/tmp/fake-thatch.db",
    modelName: "mock",
    mode: "standalone",
    transport: opts.transport ?? daemon.transport(),
    ensureDaemonRunning: opts.ensureDaemonRunning ?? (async () => "failed" as const),
    localFactory: () => {
      factoryCalls += 1;
      return local;
    },
    requestTimeoutMs: opts.requestTimeoutMs,
    cooldownMs: opts.cooldownMs,
    note: (msg) => notes.push(msg),
    now: () => now.value,
  });
  return { model, daemon, local, now, notes, factoryCalls: () => factoryCalls };
}

beforeEach(() => {
  process.env.THATCH_EMBED_DAEMON = "off";
});

describe("RemoteEmbeddingModel", () => {
  test("happy path: resolve, hello, embed, and the vector comes back", async () => {
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    const { model, local, factoryCalls } = build({ daemon });
    const vec = await model.queryEmbed("hello");
    expect([...vec]).toEqual([1, 2, 3]);
    expect(model.state).toBe("remote");
    // Lazy local: while the daemon serves, the local model is never built
    // or loaded - a daemon-served session imports no ONNX runtime.
    expect(factoryCalls()).toBe(0);
    expect(local.loads).toBe(0);
  });

  test("knob off locks local without touching the socket", async () => {
    process.env.THATCH_EMBED_DAEMON = "off";
    const daemon = new FakeDaemon();
    const { model, factoryCalls } = build({ daemon });
    const vec = await model.passageEmbed("hello");
    expect([...vec]).toEqual([8, 8, 8]);
    expect(model.state).toBe("local-locked");
    expect(daemon.connections).toBe(0);
    expect(factoryCalls()).toBe(1);
    expect(notes.join("\n")).toContain("THATCH_EMBED_DAEMON=off");
  });

  test("model mismatch at hello locks local WITHOUT spawning", async () => {
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    daemon.helloModel = "other-model";
    let spawns = 0;
    const { model, local } = build({
      daemon,
      ensureDaemonRunning: async () => {
        spawns += 1;
        return "running" as const;
      },
    });
    const vec = await model.queryEmbed("hello");
    expect([...vec]).toEqual([7, 7, 7]);
    expect(model.state).toBe("local-locked");
    expect(spawns).toBe(0);
    expect(notes.join("\n")).toContain("model mismatch");
    void local;
  });

  test("spawn failure locks local with a one-time note", async () => {
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    daemon.helloError = null;
    // No listener ever: the transport itself fails to connect.
    const failing: Transport = async () => {
      throw new Error("connect failed (ENOENT)");
    };
    notes = [];
    const local = new LocalModel();
    const model = new RemoteEmbeddingModel({
      dbPath: "/tmp/fake-thatch.db",
      modelName: "mock",
      mode: "standalone",
      transport: failing,
      ensureDaemonRunning: async () => "failed",
      localFactory: () => local,
      note: (msg) => notes.push(msg),
      now: () => 1_000_000,
    });
    const vec = await model.queryEmbed("hello");
    expect([...vec]).toEqual([7, 7, 7]);
    expect(model.state).toBe("local-locked");
    expect(notes).toHaveLength(1);
  });

  test("per-embed fallback on daemon death, then self-healing when it returns", async () => {
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    const { model, daemon: d, factoryCalls } = build({ daemon });
    expect([...await model.queryEmbed("a")]).toEqual([1, 2, 3]);

    // The daemon "dies" for embeds: the embed reports an error response
    // (the request-time failure shape). State must NOT change.
    d.embedError = "model exploded";
    expect([...await model.queryEmbed("b")]).toEqual([7, 7, 7]);
    expect(model.state).toBe("remote");
    expect(factoryCalls()).toBe(1);

    // The daemon returns: the next embed re-probes and uses it again.
    d.embedError = null;
    expect([...await model.queryEmbed("c")]).toEqual([1, 2, 3]);
    // The first-delegation note was emitted exactly once across the outage.
    const fallbackNotes = notes.filter((n) => n.includes("embedding in-process (the embed daemon answered with an error"));
    expect(fallbackNotes).toHaveLength(1);
  });

  test("mid-life connect failure delegates to local and keeps the remote state", async () => {
    // The stale-socket death shape: the daemon is GONE, the connect
    // itself fails. One request delegates; the state must NOT change -
    // the next embed re-probes, so a returning daemon is used again.
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    const { model } = build({ daemon });
    expect([...await model.queryEmbed("a")]).toEqual([1, 2, 3]);
    daemon.dead = true;
    expect([...await model.queryEmbed("b")]).toEqual([7, 7, 7]);
    expect(model.state).toBe("remote");
    expect(notes.join("\n")).toContain("the embed daemon is unreachable");
  });

  test("mid-life model mismatch locks local with only the lock note", async () => {
    // The daemon restarted serving a different model. The lock note and
    // the generic fallback note would contradict each other ("this
    // session's lifetime" vs "will re-probe") - only the lock note flies.
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    const { model } = build({ daemon });
    expect([...await model.queryEmbed("a")]).toEqual([1, 2, 3]);
    daemon.helloModel = "other-model";
    expect([...await model.queryEmbed("b")]).toEqual([7, 7, 7]);
    expect(model.state).toBe("local-locked");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("model mismatch");
    expect(notes.join("\n")).not.toContain("will re-probe");
  });

  test("a connect-stage timeout closes the connection when the dial completes late", async () => {
    // The transport resolves AFTER the connect timeout fired. The late
    // connection must be destroyed on arrival - one leaked fd per
    // connect timeout, repeating, is exactly the leak this pins shut.
    process.env.THATCH_EMBED_DAEMON = "on";
    const late = new FakeConnection(new FakeDaemon(), 0);
    let lateCloses = 0;
    late.close = () => {
      lateCloses += 1;
    };
    const slowTransport: Transport = () =>
      new Promise<DaemonConnection>((resolve) => {
        setTimeout(() => resolve(late), 80);
      });
    const { model } = build({ transport: slowTransport, requestTimeoutMs: 20 });
    expect([...await model.queryEmbed("hello")]).toEqual([7, 7, 7]);
    await new Promise((r) => setTimeout(r, 120));
    expect(lateCloses).toBe(1);
  });

  test("a wedged-but-live daemon times out, delegates to local, and never hangs", async () => {
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    daemon.wedgeEmbed = true;
    const { model, factoryCalls } = build({ daemon, requestTimeoutMs: 20 });
    const started = Date.now();
    const vec = await model.queryEmbed("hello");
    expect([...vec]).toEqual([7, 7, 7]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(factoryCalls()).toBe(1);
  });

  test("three consecutive timeouts trip a 60s cool-down; embeds stay local until it expires", async () => {
    process.env.THATCH_EMBED_DAEMON = "on";
    const daemon = new FakeDaemon();
    daemon.wedgeEmbed = true;
    const { model, daemon: d, now } = build({ daemon, requestTimeoutMs: 10, cooldownMs: 60_000 });

    for (let i = 0; i < 3; i++) await model.queryEmbed(`t${i}`);
    // Cool-down armed: further embeds do not touch the socket at all.
    const connsAtTrip = d.connections;
    await model.queryEmbed("during-cooldown");
    expect(d.connections).toBe(connsAtTrip);

    // After the cool-down expires, the wrapper re-probes (and the wedge
    // is over, so the daemon serves again).
    daemon.wedgeEmbed = false;
    now.value += 61_000;
    expect([...await model.queryEmbed("after")]).toEqual([1, 2, 3]);
  });

  test("dispose releases the local model when one was built", async () => {
    process.env.THATCH_EMBED_DAEMON = "off";
    const { model, local } = build();
    await model.queryEmbed("hello");
    await model.dispose();
    expect(local.disposed).toBe(1);
  });

  test("a throwing spawn locks local with the note; later embeds still work", async () => {
    // No listener anywhere, and the spawn itself throws (EAGAIN/ENOMEM
    // under resource pressure). The rejection must resolve local-locked
    // with the note - NOT memoize into every later embed.
    process.env.THATCH_EMBED_DAEMON = "on";
    const failing: Transport = async () => {
      throw new Error("connect failed (ENOENT)");
    };
    let spawnAttempts = 0;
    const { model, local, factoryCalls } = build({
      transport: failing,
      ensureDaemonRunning: async () => {
        spawnAttempts += 1;
        throw new Error("spawn failed: EAGAIN");
      },
    });
    expect([...await model.queryEmbed("a")]).toEqual([7, 7, 7]);
    expect(model.state).toBe("local-locked");
    expect(spawnAttempts).toBe(1);
    expect(notes.join("\n")).toContain("could not be started");
    expect(notes.join("\n")).toContain("EAGAIN");
    // Later embeds are served locally forever (locked), not poisoned by
    // the memoized rejection.
    expect([...await model.passageEmbed("b")]).toEqual([8, 8, 8]);
    expect(factoryCalls()).toBe(1);
    void local;
  });

  test("a rejected resolve clears the memo so the next embed re-runs the policy", async () => {
    // With spawn failures caught, the one rejection left is a throwing
    // note sink. The memo must clear: the second embed re-runs the policy
    // and succeeds instead of rethrowing the memoized rejection forever.
    process.env.THATCH_EMBED_DAEMON = "on";
    const failing: Transport = async () => {
      throw new Error("connect failed (ENOENT)");
    };
    const model = new RemoteEmbeddingModel({
      dbPath: "/tmp/fake-thatch.db",
      modelName: "mock",
      mode: "standalone",
      transport: failing,
      ensureDaemonRunning: async () => "failed" as const,
      localFactory: () => new LocalModel(),
      note: () => {
        throw new Error("note sink blew up");
      },
      now: () => 1_000_000,
    });
    await expect(model.queryEmbed("a")).rejects.toThrow("note sink blew up");
    // The memo cleared: the policy ran again (the note key is already
    // recorded, so this resolve completes) and the embed lands locally.
    expect([...await model.queryEmbed("b")]).toEqual([7, 7, 7]);
  });
});
