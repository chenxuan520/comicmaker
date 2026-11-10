import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionContentPart } from "openai/resources/chat/completions";
import type { ResponseFormatJSONSchema } from "openai/resources/shared";
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import { PreconditionError } from "./errors.js";
import type { AiProvider, ImageRequest, StructuredRequest, TokenUsage } from "./ports.js";

export class ResponseDecodeError extends Error {
  constructor() {
    super("Successful API response could not be decoded; fees remain estimated");
    this.name = "ResponseDecodeError";
  }
}

export class ImageResponseError extends Error {
  constructor(message: string, public readonly usage?: TokenUsage) {
    super(message);
    this.name = "ImageResponseError";
  }
}

export class OpenAiProvider implements AiProvider {
  protected readonly client: OpenAI;

  constructor(protected readonly options: { apiKey?: string; baseURL: string; llmTimeout: number; imageTimeout: number; responseFormat?: "json_object" }) {
    this.client = new OpenAI({ apiKey: options.apiKey || "not-configured", baseURL: options.baseURL, maxRetries: 0 });
  }

  ready(): void {
    if (!this.options.apiKey) throw new PreconditionError("API key is not configured. Set the configured key variable in workspace/.env or your environment.");
  }

  protected async response<T>(request: { asResponse(): Promise<Response> }): Promise<T> {
    try {
      const response = await request.asResponse();
      try {
        const payload: unknown = await response.json();
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new ResponseDecodeError();
        return payload as T;
      } catch { throw new ResponseDecodeError(); }
    } catch (error) {
      if (error instanceof Error && this.options.apiKey) {
        error.message = error.message.split(this.options.apiKey).join("[redacted]");
        if (error.stack) error.stack = error.stack.split(this.options.apiKey).join("[redacted]");
      }
      throw error;
    }
  }

  async structured(request: StructuredRequest) {
    this.ready();
    const format = request.schema as ResponseFormatJSONSchema;
    const jsonMode = this.options.responseFormat === "json_object";
    const content: ChatCompletionContentPart[] = [{ type: "text", text: request.user }];
    for (const image of request.images ?? []) {
      content.push({ type: "text", text: image.label });
      content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${encodeBase64(image.data)}` } });
    }
    const response = await this.response<ChatCompletion>(this.client.chat.completions.create({
      model: request.model,
      messages: [
        { role: "system", content: jsonMode ? `${request.system}\n\nReturn only a JSON object matching this JSON schema (${request.schema_name}):\n${JSON.stringify(format.json_schema.schema)}` : request.system },
        { role: "user", content: jsonMode && !request.images?.length ? request.user : content },
      ],
      response_format: jsonMode ? { type: "json_object" } : format,
    }, { signal: request.signal, timeout: this.options.llmTimeout }));
    const message = response.choices?.[0]?.message;
    const text = message?.refusal ? JSON.stringify({ refusal: message.refusal }) : message?.content ?? "";
    return { text, usage: response.usage ? { input_tokens: response.usage.prompt_tokens, output_tokens: response.usage.completion_tokens } : undefined };
  }

  async image(request: ImageRequest): Promise<{ data: Uint8Array; usage?: TokenUsage }> {
    this.ready();
    const params = {
      model: request.model, prompt: request.prompt, n: 1,
      size: request.size as ImageEditParamsNonStreaming["size"],
      quality: request.quality as ImageEditParamsNonStreaming["quality"],
      output_format: "png" as const,
    };
    const options = { signal: request.signal, timeout: this.options.imageTimeout };
    const response = await this.response<ImagesResponse>(request.images.length
      ? this.client.images.edit({ ...params, image: request.images.map((image) => new File([image.data.slice().buffer], image.name, { type: "image/png" })) }, options)
      : this.client.images.generate(params as ImageGenerateParamsNonStreaming, options));
    const usage = response.usage ? {
      input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
      text_input_tokens: response.usage.input_tokens_details?.text_tokens,
      image_input_tokens: response.usage.input_tokens_details?.image_tokens,
    } satisfies TokenUsage : undefined;
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new ImageResponseError("Image response did not contain b64_json; the configured service must return PNG bytes", usage);
    try {
      return { data: decodeBase64(encoded), usage };
    } catch {
      throw new ImageResponseError("Image response contained invalid base64", usage);
    }
  }
}

export function encodeBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
