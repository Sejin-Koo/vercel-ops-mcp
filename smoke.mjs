// 로컬 스모크테스트: node --env-file=.env smoke.mjs <도구> '<JSON 인자>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./lib/server.js";

const [tool, args] = process.argv.slice(2);
const server = buildServer();
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);
if (!tool) {
  const t = await client.listTools();
  console.log(t.tools.map((x) => x.name).join("\n"));
} else {
  const r = await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} });
  console.log(r.isError ? "[isError]" : "", r.content.map((c) => c.text).join("\n"));
}
await client.close();
