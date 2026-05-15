import {
  BaseChatModel,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import zodToJsonSchema from "zod-to-json-schema";

interface BoundTool {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

interface StructuredToolCallResponse {
  type: "tool_calls";
  calls: Array<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

interface StructuredFinalResponse {
  type: "final";
  content: string;
}

type StructuredOpenCodeResponse =
  | StructuredToolCallResponse
  | StructuredFinalResponse;

export interface OpenCodeChatModelInput extends BaseChatModelParams {
  baseUrl?: string;
  apiKey?: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  temperature?: number;
  maxTokens?: number;
  requestTimeoutMs?: number;
}

interface OpenCodeSession {
  id: string;
  createdAt: string;
}

interface OpenCodeMessagePart {
  type: "text" | "file" | "tool" | "reasoning";
  text?: string;
  content?: string;
  url?: string;
  filename?: string;
  mime?: string;
}

interface OpenCodeMessageResponse {
  parts: OpenCodeMessagePart[];
}

export class OpenCodeChatModel extends BaseChatModel {
  baseUrl = "http://127.0.0.1:4096";
  apiKey?: string;
  agent = "build";
  providerID = "anthropic";
  modelID = "claude-3-5-sonnet-20241022";
  temperature?: number;
  maxTokens?: number;
  private requestTimeout = 120000; // 300 second timeout for API requests
  private boundTools: BoundTool[] = [];

  constructor(fields: OpenCodeChatModelInput) {
    super(fields);

    // Validate and set baseUrl
    const baseUrl = fields.baseUrl ?? this.baseUrl;
    try {
      new URL(baseUrl);
      this.baseUrl = baseUrl;
    } catch {
      throw new Error(`Invalid baseUrl: ${baseUrl}. Must be a valid URL.`);
    }

    // Validate required fields
    const providerID = fields.providerID ?? this.providerID;
    const modelID = fields.modelID ?? this.modelID;

    if (!providerID || providerID.trim() === "") {
      throw new Error("providerID is required and cannot be empty");
    }
    if (!modelID || modelID.trim() === "") {
      throw new Error("modelID is required and cannot be empty");
    }

    this.apiKey = fields.apiKey;
    this.agent = fields.agent ?? this.agent;
    this.providerID = providerID;
    this.modelID = modelID;
    this.temperature = fields.temperature;
    this.maxTokens = fields.maxTokens;
    if (
      fields.requestTimeoutMs !== undefined &&
      Number.isFinite(fields.requestTimeoutMs) &&
      fields.requestTimeoutMs > 0
    ) {
      this.requestTimeout = fields.requestTimeoutMs;
    }
  }

  _llmType(): string {
    return "opencode";
  }

  get supportsToolCalling(): boolean {
    return true;
  }

  bindTools(
    tools: BindToolsInput[],
    _kwargs?: Partial<this["ParsedCallOptions"]>,
  ): Runnable {
    this.boundTools = tools
      .map((tool) => this.normalizeBoundTool(tool))
      .filter((tool): tool is BoundTool => tool !== undefined);

    return this as unknown as Runnable;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let sessionId: string | undefined;

    try {
      // Create fresh session for this execution
      sessionId = await this.createSession();

      // Convert messages to OpenCode prompt format
      const promptParts = this.convertMessagesToPromptParts(messages);

      // Send prompt to OpenCode and get response directly
      const responseText = await this.sendPrompt(sessionId, promptParts);

      const parsedResponse = this.parseModelResponse(responseText);
      const aiMessage = this.createAIMessage(parsedResponse, responseText);
      const responseOutput =
        parsedResponse?.type === "final" ? parsedResponse.content : responseText;

      // Notify callback manager if provided
      if (runManager) {
        await runManager.handleLLMNewToken(responseOutput);
      }

      return {
        generations: [
          {
            text: responseOutput,
            message: aiMessage,
          },
        ],
      };
    } finally {
      // Clean up session after execution if one was created
      if (sessionId) {
        await this.deleteSession(sessionId);
      }
    }
  }

  // Streaming is not implemented - OpenCode API returns complete responses
  // LangChain will automatically fall back to using _generate for streaming calls

  private async createSession(): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      const response = await fetch(`${this.baseUrl}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Failed to create OpenCode session (${response.status}): ${errorBody}`,
        );
      }

      // Validate response structure
      const data: any = await response.json();
      if (typeof data?.id !== "string") {
        throw new Error(
          'Failed to create session: API response is missing or has an invalid "id" field',
        );
      }

      const session = data as OpenCodeSession;
      return session.id;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Request to create session timed out after ${this.requestTimeout / 1000} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private convertMessagesToPromptParts(
    messages: BaseMessage[],
  ): OpenCodeMessagePart[] {
    const parts: OpenCodeMessagePart[] = [];

    for (const message of messages) {
      const prefix = this.getMessagePrefix(message);
      const content = message.content;

      if (typeof content === "string") {
        parts.push({
          type: "text",
          text: `${prefix}${content}`,
        });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === "string") {
            parts.push({
              type: "text",
              text: `${prefix}${item}`,
            });
          } else if (item.type === "text") {
            parts.push({
              type: "text",
              text: `${prefix}${item.text}`,
            });
          }
          // Could add support for image_url and other types here
        }
      }

      const toolResultText = this.serializeToolResultMessage(message);
      if (toolResultText) {
        parts.push({
          type: "text",
          text: toolResultText,
        });
      }

      const toolCallText = this.serializeAIMessageToolCalls(message);
      if (toolCallText) {
        parts.push({
          type: "text",
          text: toolCallText,
        });
      }
    }

    if (this.boundTools.length > 0) {
      parts.push({
        type: "text",
        text: this.buildToolCallingInstruction(),
      });
    }

    return parts;
  }

  private getMessagePrefix(message: BaseMessage): string {
    switch (message.getType()) {
      case "system":
        return "System: ";
      case "tool":
        return "Tool result: ";
      default:
        return "";
    }
  }

  private serializeToolResultMessage(message: BaseMessage): string | undefined {
    if (message.getType() !== "tool") {
      return undefined;
    }

    const toolCallId = "tool_call_id" in message ? message.tool_call_id : undefined;
    if (!toolCallId || typeof message.content !== "string") {
      return undefined;
    }

    return `Tool result for ${toolCallId}: ${message.content}`;
  }

  private serializeAIMessageToolCalls(message: BaseMessage): string | undefined {
    if (!(message instanceof AIMessage) || !message.tool_calls?.length) {
      return undefined;
    }

    const calls = message.tool_calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args,
    }));

    return `Assistant requested tools: ${JSON.stringify(calls)}`;
  }

  private buildToolCallingInstruction(): string {
    return [
      "You are acting as a tool-calling chat model for LangChain.",
      "Respond with ONLY valid JSON and no markdown or surrounding text.",
      "If you need to call one or more tools, return:",
      JSON.stringify(
        {
          type: "tool_calls",
          calls: [
            {
              id: "call_1",
              name: "tool_name",
              arguments: {
                example: "value",
              },
            },
          ],
        },
        null,
        2,
      ),
      "If you can answer directly, return:",
      JSON.stringify(
        {
          type: "final",
          content: "your final answer",
        },
        null,
        2,
      ),
      `Available tools: ${JSON.stringify(this.boundTools)}`,
      "Tool arguments must exactly match the available tool schemas.",
    ].join("\n");
  }

  private async sendPrompt(
    sessionId: string,
    parts: OpenCodeMessagePart[],
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      // Build request body with optional parameters
      const body: Record<string, any> = {
        parts,
        model: {
          providerID: this.providerID,
          modelID: this.modelID,
        },
        agent: this.agent,
      };

      // Add optional model parameters if specified
      if (this.temperature !== undefined) {
        body.temperature = this.temperature;
      }
      if (this.maxTokens !== undefined) {
        body.max_tokens = this.maxTokens;
      }
      const response = await fetch(
        `${this.baseUrl}/session/${sessionId}/message`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Failed to send prompt to OpenCode (${response.status}): ${errorBody}`,
        );
      }

      // Parse the response and validate structure
      const data: any = await response.json();
      if (!data || !Array.isArray(data.parts)) {
        throw new Error(
          'Invalid response from OpenCode: missing or invalid "parts" field',
        );
      }

      const responseData = data as OpenCodeMessageResponse;
      const textParts: string[] = [];

      for (const part of responseData.parts) {
        if (part.type === "text" && part.text) {
          textParts.push(part.text);
        }
      }

      // Ensure we got some text content back
      if (textParts.length === 0) {
        throw new Error(
          "OpenCode API returned a response with no text content",
        );
      }

      return textParts.join("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Request to send prompt timed out after ${this.requestTimeout / 1000} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private createAIMessage(
    parsedResponse: StructuredOpenCodeResponse | undefined,
    rawText: string,
  ): AIMessage {
    if (!parsedResponse) {
      return new AIMessage(rawText);
    }

    if (parsedResponse.type === "tool_calls") {
      return new AIMessage({
        content: "",
        tool_calls: parsedResponse.calls.map((call, index) => ({
          id: call.id ?? `call_${index + 1}`,
          name: call.name,
          args: call.arguments,
          type: "tool_call",
        })),
      });
    }

    return new AIMessage(parsedResponse.content);
  }

  private parseModelResponse(
    responseText: string,
  ): StructuredOpenCodeResponse | undefined {
    if (this.boundTools.length === 0) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.extractJsonObject(responseText)) as unknown;
    } catch {
      return {
        type: "final",
        content: responseText,
      };
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return {
        type: "final",
        content: responseText,
      };
    }

    const response = parsed as Record<string, unknown>;

    if (response.type === "final") {
      if (typeof response.content !== "string") {
        throw new Error("OpenCode final response is missing string content");
      }

      return {
        type: "final",
        content: response.content,
      };
    }

    if (response.type === "tool_calls") {
      if (!Array.isArray(response.calls)) {
        throw new Error("OpenCode tool response is missing calls array");
      }

      return {
        type: "tool_calls",
        calls: response.calls.map((call: unknown, index: number) =>
          this.validateStructuredToolCall(call, index),
        ),
      };
    }

    throw new Error(
      `Unsupported OpenCode structured response type: ${String(response.type)}`,
    );
  }

  private validateStructuredToolCall(
    call: unknown,
    index: number,
  ): StructuredToolCallResponse["calls"][number] {
    if (!call || typeof call !== "object") {
      throw new Error(`Tool call at index ${index} is not an object`);
    }

    const name = "name" in call ? call.name : undefined;
    const args = "arguments" in call ? call.arguments : undefined;
    const id = "id" in call ? call.id : undefined;

    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`Tool call at index ${index} is missing a valid name`);
    }

    if (!this.boundTools.some((tool) => tool.name === name)) {
      throw new Error(`OpenCode requested unknown tool: ${name}`);
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`Tool call ${name} is missing a valid arguments object`);
    }

    return {
      id: typeof id === "string" && id.length > 0 ? id : undefined,
      name,
      arguments: args as Record<string, unknown>,
    };
  }

  private extractJsonObject(responseText: string): string {
    const trimmed = responseText.trim();
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch) {
      return fencedMatch[1].trim();
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error("OpenCode did not return a JSON object");
    }

    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  private normalizeBoundTool(tool: BindToolsInput): BoundTool | undefined {
    if (!tool || typeof tool !== "object") {
      return undefined;
    }

    const toolRecord = tool as Record<string, unknown>;

    const name = "name" in toolRecord ? toolRecord.name : undefined;
    if (typeof name !== "string" || name.length === 0) {
      return undefined;
    }

    return {
      name,
      description:
        "description" in toolRecord && typeof toolRecord.description === "string"
          ? toolRecord.description
          : undefined,
      schema: this.extractToolSchema(toolRecord),
    };
  }

  private extractToolSchema(
    tool: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const schema = tool.schema ?? tool.parameters ?? tool.inputSchema;

    if (!schema) {
      return undefined;
    }

    if (this.isZodSchema(schema)) {
      const convertZodSchema = zodToJsonSchema as unknown as (
        input: unknown,
      ) => Record<string, unknown>;
      return convertZodSchema(schema);
    }

    return this.asObject(schema);
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private isZodSchema(value: unknown): boolean {
    return !!value && typeof value === "object" && "safeParse" in value;
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.requestTimeout,
      );

      try {
        await fetch(`${this.baseUrl}/session/${sessionId}`, {
          method: "DELETE",
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          console.warn(
            `Session deletion timed out after ${this.requestTimeout / 1000} seconds for session ${sessionId}`,
          );
        } else {
          // Log cleanup errors for monitoring but don't throw
          console.warn(
            `Failed to clean up OpenCode session ${sessionId}:`,
            error,
          );
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // Log any outer errors but don't throw
      console.warn(`Error during session cleanup for ${sessionId}:`, error);
    }
  }

  // Deprecated: Kept for backward compatibility, but no longer needed
  async cleanup(): Promise<void> {
    // Sessions are now cleaned up automatically per-execution
  }
}
