import type {
  ISupplyDataFunctions,
  INodeType,
  INodeTypeDescription,
  SupplyData,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";
import { NodeConnectionTypes } from "n8n-workflow";
import { OpenCodeChatModel } from "./OpenCodeChatModel";

export class LmChatOpenCode implements INodeType {
  description: INodeTypeDescription = {
    displayName: "OpenCode Chat Model",
    name: "lmChatOpenCode",
    icon: "file:opencode.svg",
    group: ["transform"],
    version: 1,
    description: "Use OpenCode self-hosted AI coding agent as a chat model",
    defaults: {
      name: "OpenCode Chat Model",
    },
    codex: {
      categories: ["AI"],
      subcategories: {
        AI: ["Language Models", "Agents"],
      },
      resources: {
        primaryDocumentation: [
          {
            url: "https://opencode.ai/docs/",
          },
        ],
      },
    },
    credentials: [
      {
        name: "openCodeApi",
        required: false,
      },
    ],
    inputs: [],
    outputs: [NodeConnectionTypes.AiLanguageModel],
    outputNames: ["Model"],
    properties: [
      {
        displayName: "Transport",
        name: "transport",
        type: "options",
        description: "How to connect to OpenCode",
        default: "rest",
        options: [
          { name: "REST", value: "rest" },
          { name: "ACP (Local)", value: "acp" },
          { name: "ACP (HTTP bridge)", value: "acp-http" },
        ],
      },
      {
        displayName: "Agent",
        name: "agent",
        type: "options",
        description: "The OpenCode agent to use",
        default: "build",
        typeOptions: {
          loadOptionsMethod: "getAgents",
        },
        displayOptions: { show: { transport: ["rest"] } },
      },
      {
        displayName: "Model Provider",
        name: "providerID",
        type: "options",
        description: "The model provider to use",
        default: "anthropic",
        typeOptions: {
          loadOptionsMethod: "getProviders",
        },
        displayOptions: { show: { transport: ["rest"] } },
      },
      {
        displayName: "Model ID",
        name: "modelID",
        type: "options",
        description: "The specific model to use",
        default: "claude-3-5-sonnet-20241022",
        typeOptions: {
          loadOptionsMethod: "getModels",
        },
        displayOptions: { show: { transport: ["rest"] } },
      },
      {
        displayName: "ACP Provider ID",
        name: "acpProviderID",
        type: "string",
        description: "Provider ID passed to local OpenCode ACP",
        default: "",
        displayOptions: { show: { transport: ["acp", "acp-http"] } },
      },
      {
        displayName: "ACP Model ID",
        name: "acpModelID",
        type: "string",
        description: "Model ID passed to local OpenCode ACP",
        default: "",
        displayOptions: { show: { transport: ["acp", "acp-http"] } },
      },
      {
        displayName: "ACP Executable",
        name: "acpExecutable",
        type: "string",
        description:
          "Executable used for local OpenCode ACP. Must exist in the same runtime.",
        default: "opencode",
        displayOptions: { show: { transport: ["acp"] } },
      },
      {
        displayName: "ACP Working Directory",
        name: "acpCwd",
        type: "string",
        description:
          "Absolute working directory for local OpenCode ACP. Leave empty to use the runtime working directory.",
        default: "",
        placeholder: "/workspace/project",
        typeOptions: {
          validation: [
            {
              type: "regex",
              properties: {
                regex: "^(?:$|/|[A-Za-z]:[\\\\/])",
                errorMessage: "Working directory must be an absolute path.",
              },
            },
          ],
        },
        displayOptions: { show: { transport: ["acp"] } },
      },
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        default: {},
        placeholder: "Add Option",
        options: [
          {
            displayName: "Base URL",
            name: "baseUrl",
            type: "string",
            default: "",
            description:
              "Override the base URL from credentials. Leave empty to use credentials.",
            placeholder: "http://opencode-service:4096",
            displayOptions: { show: { transport: ["rest"] } },
          },
          {
            displayName: "ACP Bridge URL",
            name: "acpBridgeUrl",
            type: "string",
            default: "",
            description: "HTTP endpoint for the ACP bridge.",
            placeholder: "https://acp-bridge.example.com",
            displayOptions: { show: { transport: ["acp-http"] } },
          },
          {
            displayName: "Temperature",
            name: "temperature",
            type: "number",
            default: 0.7,
            typeOptions: {
              maxValue: 2,
              minValue: 0,
              numberPrecision: 2,
            },
            description:
              "Controls randomness in the response. Lower values make output more focused and deterministic.",
            displayOptions: { show: { transport: ["rest"] } },
          },
          {
            displayName: "Maximum Tokens",
            name: "maxTokens",
            type: "number",
            default: -1,
            description:
              "Maximum number of tokens to generate. -1 means no limit.",
            displayOptions: { show: { transport: ["rest"] } },
          },
          {
            displayName: "Request Timeout (ms)",
            name: "requestTimeoutMs",
            type: "number",
            default: 120000,
            description:
              "Maximum time to wait for an OpenCode API response in milliseconds.",
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      /**
       * Fetches available providers from OpenCode API.
       * Transforms the provider object keys into dropdown options.
       * Returns empty array if server is unreachable.
       */
      async getProviders(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("openCodeApi");
        const baseUrl =
          (credentials?.baseUrl as string) || "http://127.0.0.1:4096";
        const apiKey = credentials?.apiKey as string | undefined;

        try {
          const response = await this.helpers.httpRequest({
            method: "GET",
            url: `${baseUrl}/config/providers`,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });

          // Transform providers array to options
          return response.providers
            .map((provider: any) => ({
              name: provider.name,
              value: provider.id,
            }))
            .sort((a: INodePropertyOptions, b: INodePropertyOptions) =>
              a.name.localeCompare(b.name),
            );
        } catch (error) {
          console.warn(
            "Failed to load providers from OpenCode:",
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      },

      /**
       * Fetches available agents from OpenCode API.
       * Transforms the agents array into dropdown options.
       * Returns empty array if server is unreachable.
       */
      async getAgents(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("openCodeApi");
        const baseUrl =
          (credentials?.baseUrl as string) || "http://127.0.0.1:4096";
        const apiKey = credentials?.apiKey as string | undefined;

        try {
          const response = await this.helpers.httpRequest({
            method: "GET",
            url: `${baseUrl}/agent`,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });

          // Transform agents array to options
          // Response is array of objects with 'name' field
          return response
            .map((agent: any) => ({
              name: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
              value: agent.name,
            }))
            .sort((a: INodePropertyOptions, b: INodePropertyOptions) =>
              a.name.localeCompare(b.name),
            );
        } catch (error) {
          console.warn(
            "Failed to load agents from OpenCode:",
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      },

      /**
       * Fetches available models for the currently selected provider.
       * Requires providerID parameter to be set.
       * Returns empty array if no provider selected or server unreachable.
       */
      async getModels(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("openCodeApi");
        const baseUrl =
          (credentials?.baseUrl as string) || "http://127.0.0.1:4096";
        const apiKey = credentials?.apiKey as string | undefined;
        const providerID = this.getCurrentNodeParameter("providerID") as string;

        if (!providerID) {
          return [];
        }

        try {
          const response = await this.helpers.httpRequest({
            method: "GET",
            url: `${baseUrl}/config/providers`,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });

          // Find provider in array and get models object
          const provider = response.providers.find(
            (p: any) => p.id === providerID,
          );
          const models = provider?.models || {};

          // Convert models object keys to array
          return Object.keys(models).map((modelId: string) => ({
            name: modelId,
            value: modelId,
          }));
        } catch (error) {
          console.warn(
            "Failed to load models from OpenCode:",
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      },
    },
  };

  async supplyData(
    this: ISupplyDataFunctions,
    itemIndex: number,
  ): Promise<SupplyData> {
    const transport = this.getNodeParameter("transport", itemIndex, "rest") as
      "rest" | "acp" | "acp-http";
    const credentials =
      transport !== "acp"
        ? await this.getCredentials("openCodeApi")
        : undefined;
    const agent =
      transport === "rest"
        ? (this.getNodeParameter("agent", itemIndex, "build") as string)
        : undefined;
    const providerID = this.getNodeParameter(
      transport === "rest" ? "providerID" : "acpProviderID",
      itemIndex,
      transport === "rest" ? "anthropic" : "",
    ) as string;
    const modelID = this.getNodeParameter(
      transport === "rest" ? "modelID" : "acpModelID",
      itemIndex,
      transport === "rest" ? "claude-3-5-sonnet-20241022" : "",
    ) as string;
    const acpExecutable =
      transport === "acp"
        ? (this.getNodeParameter(
            "acpExecutable",
            itemIndex,
            "opencode",
          ) as string)
        : undefined;
    const acpCwd =
      transport === "acp"
        ? (this.getNodeParameter("acpCwd", itemIndex, "") as string) ||
          undefined
        : undefined;
    const options = this.getNodeParameter("options", itemIndex, {}) as {
      baseUrl?: string;
      acpBridgeUrl?: string;
      temperature?: number;
      maxTokens?: number;
      requestTimeoutMs?: number;
    };

    // Use baseUrl from options, fallback to credentials, fallback to default
    const baseUrl =
      transport === "acp-http"
        ? options.acpBridgeUrl
        : options.baseUrl ||
          (credentials?.baseUrl as string) ||
          "http://localhost:4096";

    if (transport === "acp-http") {
      if (!baseUrl) {
        throw new Error("ACP Bridge URL is required for ACP (HTTP bridge).");
      }
      try {
        new URL(baseUrl);
      } catch {
        throw new Error(`Invalid ACP Bridge URL: ${baseUrl}`);
      }
    }

    const model = new OpenCodeChatModel({
      baseUrl,
      apiKey: credentials?.apiKey as string | undefined,
      agent,
      providerID,
      modelID,
      temperature: options.temperature,
      maxTokens: options.maxTokens !== -1 ? options.maxTokens : undefined,
      requestTimeoutMs: options.requestTimeoutMs,
      transport,
      acpExecutable,
      cwd: acpCwd,
    });

    return {
      response: model,
    };
  }
}
