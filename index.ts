#!/usr/bin/env node

// TEST CONFIGURATION
let cachedIndices: Array<any> | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 600_000; // 10 min in ms

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client, estypes, ClientOptions } from "@elastic/elasticsearch";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";

// Configuration schema with auth options
const ConfigSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, "Elasticsearch URL cannot be empty")
      .url("Invalid Elasticsearch URL format")
      .describe("Elasticsearch server URL"),

    apiKey: z
      .string()
      .optional()
      .describe("API key for Elasticsearch authentication"),

    username: z
      .string()
      .optional()
      .describe("Username for Elasticsearch authentication"),

    password: z
      .string()
      .optional()
      .describe("Password for Elasticsearch authentication"),

    caCert: z
      .string()
      .optional()
      .describe("Path to custom CA certificate for Elasticsearch"),
  })
  .refine(
    (data) => {
      // Either apiKey is present, or both username and password are present
      return !!data.apiKey || (!!data.username && !!data.password);
    },
    {
      message:
        "Either ES_API_KEY or both ES_USERNAME and ES_PASSWORD must be provided",
      path: ["apiKey", "username", "password"],
    }
  );

type ElasticsearchConfig = z.infer<typeof ConfigSchema>;

export async function createElasticsearchMcpServer(
  config: ElasticsearchConfig
) {
  const validatedConfig = ConfigSchema.parse(config);
  const { url, apiKey, username, password, caCert } = validatedConfig;

  const clientOptions: ClientOptions = {
    node: url,
  };

  // Set up authentication
  if (apiKey) {
    clientOptions.auth = { apiKey };
  } else if (username && password) {
    clientOptions.auth = { username, password };
  }

  // Set up SSL/TLS certificate if provided
  if (caCert) {
    try {
      const ca = fs.readFileSync(caCert);
      clientOptions.tls = { ca };
    } catch (error) {
      console.error(
        `Failed to read certificate file: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const esClient = new Client(clientOptions);

  const server = new McpServer({
    name: "elasticsearch-mcp-server",
    version: "0.1.1",
  });

  // Tool 1: List indices
  server.tool(
    "list_indices",
    "List all available Elasticsearch indices (cached)",
    {},
    async () => {
    const now = Date.now();

    // Проверка валидности кеша
    if (cachedIndices && cacheTimestamp && now - cacheTimestamp < CACHE_DURATION) {
      return {
        content: [
          {
            type: "text",
            text: `Found ${cachedIndices.length} indices (cached)`,
          },
          {
            type: "text",
            text: JSON.stringify(cachedIndices, null, 2),
          },
        ],
      };
    }

    try {
      const response = await esClient.cat.indices({ format: "json" });

      cachedIndices = response.map((index) => ({
        index: index.index,
        health: index.health,
        status: index.status,
        docsCount: index.docsCount,
      }));

      cacheTimestamp = now;

      return {
        content: [
          {
            type: "text",
            text: `Found ${cachedIndices.length} indices`,
          },
          {
            type: "text",
            text: JSON.stringify(cachedIndices, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error(`Failed to list indices: ${error}`);
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
      };
    }
  }
);

  // Tool 2: Get mappings for an index
  server.tool(
    "get_mappings",
    "Get field mappings for a specific Elasticsearch index",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Name of the Elasticsearch index to get mappings for"),
    },
    async ({ index }) => {
      try {
        const mappingResponse = await esClient.indices.getMapping({
          index,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Mappings for index: ${index}`,
            },
            {
              type: "text" as const,
              text: `Mappings for index ${index}: ${JSON.stringify(
                mappingResponse[index]?.mappings || {},
                null,
                2
              )}`,
            },
          ],
        };
      } catch (error) {
        console.error(
          `Failed to get mappings: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );

  // Tool 3: Search an index with simplified parameters
  // Изменённый search tool с явным указанием индекса
server.tool(
  "search",
  "Perform Elasticsearch search on a specified index. User must provide exact index name explicitly.",
  {
    index: z
      .string()
      .trim()
      .min(1, "Exact index name is required.")
      .describe("Explicit Elasticsearch index name"),

    queryBody: z
      .record(z.any())
      .refine((val) => {
        try {
          JSON.parse(JSON.stringify(val));
          return true;
        } catch {
          return false;
        }
      }, { message: "queryBody must be a valid Elasticsearch query DSL object" })
      .describe("Elasticsearch query DSL object."),
  },
  async ({ index, queryBody }) => {
    try {
      const searchRequest: estypes.SearchRequest = {
        index,
        ...queryBody,
        highlight: { fields: { "*": {} } },
      };

      const result = await esClient.search(searchRequest);
      const from = queryBody.from || 0;

      const contentFragments = result.hits.hits.map((hit) => ({
        type: "text" as const, // <-- Исправление здесь
        text: JSON.stringify(hit._source, null, 2),
      }));

      const metadataFragment = {
        type: "text" as const, // <-- Исправление здесь
        text: `Total results: ${
          typeof result.hits.total === "number"
            ? result.hits.total
            : result.hits.total?.value || 0
        }, showing ${result.hits.hits.length} from position ${from}`,
      };

      return { content: [metadataFragment, ...contentFragments] };
    } catch (error) {
      console.error(`Search failed: ${error}`);
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] }; // <-- Исправление здесь
    }
  }
);

  return server;
}

const config: ElasticsearchConfig = {
  url: process.env.ES_URL || "",
  apiKey: process.env.ES_API_KEY || "",
  username: process.env.ES_USERNAME || "",
  password: process.env.ES_PASSWORD || "",
  caCert: process.env.ES_CA_CERT || "",
};

async function main() {
  const transport = new StdioServerTransport();
  const server = await createElasticsearchMcpServer(config);

  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(
    "Server error:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
