import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { OpenCodeAcpClient } from "../nodes/LmChatOpenCode/OpenCodeAcpClient";

jest.mock("node:child_process", () => ({ spawn: jest.fn() }));

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killedSignals: string[] = [];
  readonly writtenChunks: string[] = [];
  onWrite?: (message: RpcMessage) => void;
  readonly stdin = {
    write: (chunk: Buffer) => {
      const body = chunk.toString("utf8");
      this.writtenChunks.push(body);
      this.onWrite?.(JSON.parse(body.trim()) as RpcMessage);
      return true;
    },
  };

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal ?? "SIGTERM");
    this.exitCode = 0;
    this.emit("exit", 0, signal ?? null);
    return true;
  }

  send(message: Record<string, unknown>): void {
    const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    const split = Math.floor(line.length / 2);
    this.stdout.emit("data", line.subarray(0, split));
    this.stdout.emit("data", line.subarray(split));
  }
}

const spawnMock = childProcess.spawn as jest.MockedFunction<
  typeof childProcess.spawn
>;

describe("OpenCodeAcpClient", () => {
  let child: FakeChildProcess;
  let requests: RpcMessage[];

  beforeEach(() => {
    child = new FakeChildProcess();
    requests = [];
    spawnMock.mockReturnValue(
      child as unknown as ReturnType<typeof childProcess.spawn>,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("completes ACP lifecycle and collects streamed text", async () => {
    const originalEnv = process.env;
    process.env = {
      PATH: "/bin",
      HOME: "/home/test",
      TMPDIR: "/tmp/test",
      OPENCODE_CONFIG: "/tmp/opencode.json",
      N8N_SECRET: "must-not-leak",
    };
    child.onWrite = (message) => {
      requests.push(message);
      if (message.method === "initialize") {
        child.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: 1 },
        });
      } else if (message.method === "session/new") {
        child.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId: "session-1" },
        });
      } else if (message.method === "session/set_model") {
        child.send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "session/prompt") {
        child.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "hello " },
            },
          },
        });
        child.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "world" },
            },
          },
        });
        child.send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    };

    try {
      await expect(
        new OpenCodeAcpClient({
          providerID: "anthropic",
          modelID: "test-model",
          timeoutMs: 100,
          cwd: "/tmp/project",
          acpExecutable: "/wrapper/opencode",
        }).prompt("Say hello"),
      ).resolves.toBe("hello world");
    } finally {
      process.env = originalEnv;
    }

    expect(spawnMock).toHaveBeenCalledWith(
      "/wrapper/opencode",
      ["acp"],
      expect.objectContaining({
        env: {
          PATH: "/bin",
          HOME: "/home/test",
          TMPDIR: "/tmp/test",
          OPENCODE_CONFIG: "/tmp/opencode.json",
        },
      }),
    );
    expect(spawnMock.mock.calls[0][2]?.env).not.toHaveProperty("N8N_SECRET");

    expect(requests.map(({ method }) => method)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    expect(requests[1].params).toEqual({ cwd: "/tmp/project", mcpServers: [] });
    expect(requests[2].params).toEqual({
      sessionId: "session-1",
      modelId: "anthropic/test-model",
    });
    expect(requests[3].params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "Say hello" }],
    });
    expect(child.writtenChunks.every((chunk) => chunk.endsWith("\n"))).toBe(
      true,
    );
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("rejects JSON-RPC errors and still cleans up child process", async () => {
    child.onWrite = (message) => {
      child.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "not authorized" },
      });
    };

    await expect(
      new OpenCodeAcpClient({
        providerID: "anthropic",
        modelID: "test-model",
        timeoutMs: 100,
      }).prompt("fail"),
    ).rejects.toThrow("not authorized");
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("rejects incoming numeric-id requests with method-not-found", async () => {
    child.onWrite = (message) => {
      if (message.method === "initialize") {
        child.send({ jsonrpc: "2.0", id: message.id, result: {} });
        child.send({ jsonrpc: "2.0", id: 99, method: "unknown/request" });
        child.send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    };

    await expect(
      new OpenCodeAcpClient({
        providerID: "anthropic",
        modelID: "test-model",
        timeoutMs: 100,
      }).prompt("fail"),
    ).rejects.toThrow("OpenCode ACP request timed out: session/new");
    expect(JSON.parse(child.writtenChunks[1])).toEqual({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("supports string JSON-RPC ids for responses and requests", async () => {
    child.onWrite = (message) => {
      const id = String(message.id);
      if (message.method === "initialize") {
        child.send({ jsonrpc: "2.0", id, result: {} });
        child.send({
          jsonrpc: "2.0",
          id: "incoming",
          method: "unknown/request",
        });
      } else if (message.method === "session/new") {
        child.send({ jsonrpc: "2.0", id, result: { sessionId: "session-1" } });
      } else if (message.method === "session/set_model") {
        child.send({ jsonrpc: "2.0", id, result: {} });
      } else if (message.method === "session/prompt") {
        child.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "ok" },
            },
          },
        });
        child.send({ jsonrpc: "2.0", id, result: {} });
      }
    };

    await expect(
      new OpenCodeAcpClient({
        providerID: "anthropic",
        modelID: "test-model",
        timeoutMs: 100,
      }).prompt("test"),
    ).resolves.toBe("ok");
    expect(JSON.parse(child.writtenChunks[1])).toEqual({
      jsonrpc: "2.0",
      id: "incoming",
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("validates ACP provider and model before spawning", () => {
    expect(
      () =>
        new OpenCodeAcpClient({
          providerID: "",
          modelID: "model",
          timeoutMs: 100,
        }),
    ).toThrow("providerID is required");
    expect(
      () =>
        new OpenCodeAcpClient({
          providerID: "provider",
          modelID: "",
          timeoutMs: 100,
        }),
    ).toThrow("modelID is required");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("requires absolute cwd", () => {
    expect(
      () =>
        new OpenCodeAcpClient({
          providerID: "anthropic",
          modelID: "test-model",
          timeoutMs: 100,
          cwd: "relative/project",
        }),
    ).toThrow("cwd must be absolute");
  });

  it("times out without leaving child process alive", async () => {
    jest.useFakeTimers();
    child.onWrite = () => undefined;
    const prompt = new OpenCodeAcpClient({
      providerID: "anthropic",
      modelID: "test-model",
      timeoutMs: 10,
    }).prompt("hang");

    await Promise.resolve();
    jest.advanceTimersByTime(10);

    await expect(prompt).rejects.toThrow(
      "OpenCode ACP request timed out: initialize",
    );
    expect(child.killedSignals).toEqual(["SIGTERM"]);
    expect(child.exitCode).toBe(0);
  });

  it("fails closed when child exits before replying", async () => {
    child.onWrite = () => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    };

    await expect(
      new OpenCodeAcpClient({
        providerID: "anthropic",
        modelID: "test-model",
        timeoutMs: 100,
      }).prompt("exit"),
    ).rejects.toThrow("OpenCode ACP exited (1)");
    expect(child.killedSignals).toEqual([]);
  });

  it("uses ACP_BRIDGE_TOKEN for HTTP bridge authorization", async () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;
    process.env = { ...originalEnv, ACP_BRIDGE_TOKEN: "env-token" };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: async () => JSON.stringify({ text: "ok" }),
    });

    try {
      await expect(
        new OpenCodeAcpClient({
          providerID: "anthropic",
          modelID: "test-model",
          timeoutMs: 100,
          httpUrl: "http://bridge.test/acp",
        }).prompt("test"),
      ).resolves.toBe("ok");
      expect(global.fetch).toHaveBeenCalledWith(
        "http://bridge.test/acp",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer env-token",
          }),
        }),
      );
    } finally {
      process.env = originalEnv;
      global.fetch = originalFetch;
    }
  });

  it("prefers configured HTTP bridge token over environment token", async () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;
    process.env = { ...originalEnv, ACP_BRIDGE_TOKEN: "env-token" };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: async () => JSON.stringify({ text: "ok" }),
    });

    try {
      await new OpenCodeAcpClient({
        providerID: "anthropic",
        modelID: "test-model",
        timeoutMs: 100,
        httpUrl: "http://bridge.test/acp",
        bearerToken: "configured-token",
      }).prompt("test");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer configured-token",
          }),
        }),
      );
    } finally {
      process.env = originalEnv;
      global.fetch = originalFetch;
    }
  });

  it("returns clear error for unauthorized HTTP bridge response", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: null,
      text: async () => "token=secret-token",
    });

    try {
      await expect(
        new OpenCodeAcpClient({
          providerID: "anthropic",
          modelID: "test-model",
          timeoutMs: 100,
          httpUrl: "http://bridge.test/acp",
          bearerToken: "secret-token",
        }).prompt("test"),
      ).rejects.toThrow("OpenCode ACP HTTP bridge authentication failed (401)");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
