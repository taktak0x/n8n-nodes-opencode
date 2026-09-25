import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface OpenCodeAcpClientOptions {
  providerID: string;
  modelID: string;
  timeoutMs: number;
  cwd?: string;
  acpExecutable?: string;
}

export class OpenCodeAcpClient {
  private readonly options: OpenCodeAcpClientOptions;
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private text = "";

  constructor(options: OpenCodeAcpClientOptions) {
    if (!options.providerID || options.providerID.trim() === "") {
      throw new Error(
        "OpenCode ACP providerID is required and cannot be empty",
      );
    }
    if (!options.modelID || options.modelID.trim() === "") {
      throw new Error("OpenCode ACP modelID is required and cannot be empty");
    }
    const cwd = options.cwd ?? process.cwd();
    if (!isAbsolute(cwd)) {
      throw new Error(`OpenCode ACP cwd must be absolute: ${cwd}`);
    }
    this.options = options;
    this.options.cwd = cwd;
  }

  async prompt(prompt: string): Promise<string> {
    if (this.process) {
      throw new Error("OpenCode ACP client is already running");
    }
    this.buffer = Buffer.alloc(0);
    this.text = "";
    this.pending.clear();
    const deadline = Date.now() + this.options.timeoutMs;
    try {
      this.startProcess();
      await this.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "n8n-opencode", version: "1.0.0" },
        },
        deadline,
      );

      const session = await this.request(
        "session/new",
        { cwd: this.options.cwd ?? process.cwd(), mcpServers: [] },
        deadline,
      );
      const sessionId = this.getString(session, "sessionId");

      await this.request(
        "session/set_model",
        {
          sessionId,
          modelId: `${this.options.providerID}/${this.options.modelID}`,
        },
        deadline,
      );

      await this.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: prompt }] },
        deadline,
      );

      if (!this.text) {
        throw new Error("OpenCode ACP returned no text content");
      }
      return this.text;
    } finally {
      await this.stopProcess();
    }
  }

  private startProcess(): void {
    this.process = spawn(this.options.acpExecutable ?? "opencode", ["acp"], {
      cwd: this.options.cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key === "PATH" ||
            key === "HOME" ||
            key === "TMPDIR" ||
            key.startsWith("OPENCODE_"),
        ),
      ),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => {
      try {
        this.consume(chunk);
      } catch (error) {
        this.rejectPending(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.process?.kill("SIGTERM");
      }
    });
    this.process.stderr.on("data", () => undefined);
    this.process.on("error", (error) => this.rejectPending(error));
    this.process.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        this.rejectPending(
          new Error(`OpenCode ACP exited (${code ?? signal ?? "unknown"})`),
        );
      }
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown> {
    const process = this.process;
    if (!process) {
      return Promise.reject(new Error("OpenCode ACP process is not running"));
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new Error("OpenCode ACP request timed out"));
    }

    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenCode ACP request timed out: ${method}`));
      }, remaining);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      process.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let separator = this.buffer.indexOf("\n");
    while (separator >= 0) {
      const body = this.buffer
        .subarray(0, separator)
        .toString("utf8")
        .replace(/\r$/, "");
      this.buffer = this.buffer.subarray(separator + 1);
      if (body) this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      separator = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number" || typeof message.id === "string") {
      if (message.method) {
        this.sendError(message.id, -32601, "Method not found");
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "OpenCode ACP error"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "session/update") {
      const update = message.params?.update;
      if (
        update &&
        typeof update === "object" &&
        "sessionUpdate" in update &&
        update.sessionUpdate === "agent_message_chunk" &&
        "content" in update &&
        typeof update.content === "object" &&
        update.content !== null &&
        "text" in update.content &&
        typeof update.content.text === "string"
      ) {
        this.text += update.content.text;
      }
    }
  }

  private sendError(id: number | string, code: number, message: string): void {
    this.process?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
    );
  }

  private getString(value: unknown, key: string): string {
    if (!value || typeof value !== "object" || !(key in value)) {
      throw new Error(`OpenCode ACP response missing ${key}`);
    }
    const result = (value as Record<string, unknown>)[key];
    if (typeof result !== "string" || !result) {
      throw new Error(`OpenCode ACP response has invalid ${key}`);
    }
    return result;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async stopProcess(): Promise<void> {
    const process = this.process;
    this.process = undefined;
    if (!process || process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (process.exitCode === null) {
          process.kill("SIGKILL");
        }
        finish();
      }, 1000);
      process.once("exit", finish);
      if (process.exitCode === null) process.kill("SIGTERM");
    });
  }
}
