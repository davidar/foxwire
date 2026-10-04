// foxwire stdio MCP server: one per Claude Code session. Thin: tool calls → broker requests (docs/DESIGN.md §2, §5).
// stdout is the MCP transport; everything human-readable goes to stderr. The broker outlives us by design.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { socketPath } from "../broker/paths.ts";
import { BrokerClient, log } from "./client.ts";
import { createTools } from "./tools.ts";

const VERSION = "0.1.2";

const client = new BrokerClient();
const tools = createTools(client);
const server = new Server({ name: "foxwire", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => tools.call(req.params.name, req.params.arguments ?? {}));

const exit = (why: string) => {
  log(`${why}; exiting (broker stays up)`);
  client.close();
  process.exit(0);
};
process.on("SIGINT", () => exit("SIGINT"));
process.on("SIGTERM", () => exit("SIGTERM"));
process.stdin.on("end", () => exit("stdin closed"));
server.onclose = () => exit("transport closed");

await server.connect(new StdioServerTransport());
log(`v${VERSION} ready on stdio; broker socket ${socketPath()}`);
