import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeBase64 } from "../src/core/ai.js";
import type { StructuredRequest } from "../src/core/ports.js";
import { mockOutput, png } from "./helpers.js";

export interface MockOpenaiRequest {
  method: string | undefined;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  payload: Record<string, unknown>;
  response_name?: string;
  files: { field: string; name: string; type: string; data: Uint8Array }[];
}

export async function startMockOpenai() {
  const requests: MockOpenaiRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      const recorded: MockOpenaiRequest = { method: request.method, path, headers: request.headers, body, payload: {}, files: [] };
      requests.push(recorded);
      const contentType = request.headers["content-type"] ?? "";
      if (contentType.startsWith("multipart/form-data")) {
        const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
        for (const [field, value] of form) {
          if (typeof value === "string") recorded.payload[field] = value;
          else recorded.files.push({ field, name: value.name, type: value.type, data: new Uint8Array(await value.arrayBuffer()) });
        }
      } else recorded.payload = JSON.parse(body.toString("utf8"));

      let result: unknown;
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const format = recorded.payload.response_format as { json_schema: { name: string } };
        recorded.response_name = format.json_schema.name;
        const fake: StructuredRequest = {
          model: recorded.payload.model as string, system: "", user: "",
          schema: format, schema_name: recorded.response_name,
        };
        result = {
          id: `chatcmpl-mock-${requests.length}`, object: "chat.completion", model: fake.model, created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(mockOutput(fake)) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
      } else if (request.method === "POST" && ["/v1/images/generations", "/v1/images/edits"].includes(path)) {
        result = {
          created: Math.floor(Date.now() / 1000), data: [{ b64_json: encodeBase64(png) }],
          usage: { input_tokens: 120, input_tokens_details: { text_tokens: 80, image_tokens: 40 }, output_tokens: 20, total_tokens: 140 },
        };
      } else {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Unexpected mock endpoint: ${request.method} ${path}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
