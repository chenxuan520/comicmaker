import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { Config } from "../../schemas/index.js";
import { decodeBase64, encodeBase64, ImageResponseError, OpenAiProvider } from "../core/ai.js";
import type { AiKind, AiProvider, ImageRequest, StructuredRequest, TokenUsage } from "../core/ports.js";
import { apiKey } from "./config.js";

const connections = {
  deepseek: { base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" },
  seedream: { base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key_env: "ARK_API_KEY" },
  qwen: { base_url: "https://dashscope.aliyuncs.com/api/v1", api_key_env: "DASHSCOPE_API_KEY" },
};

export function aiConnection(config: Config, kind: AiKind) {
  const settings = kind === "text" ? config.llm : kind === "vision" ? config.review : config.image;
  const defaults = settings.provider === "openai" ? config.openai : connections[settings.provider];
  return { base_url: settings.base_url ?? defaults.base_url, api_key_env: settings.api_key_env ?? defaults.api_key_env };
}

export async function aiKeys(workspace: string, config: Config) {
  const [text, vision, image] = await Promise.all((["text", "vision", "image"] as const).map((kind) => apiKey(workspace, aiConnection(config, kind))));
  return { text, vision, image };
}

export class ConfiguredAiProvider implements AiProvider {
  private readonly providers: { text: AiProvider; vision: AiProvider; image: Pick<AiProvider, "ready" | "image"> };

  constructor(config: Config, keys: Record<AiKind, string | undefined>) {
    const options = (kind: AiKind) => ({
      apiKey: keys[kind], baseURL: aiConnection(config, kind).base_url,
      llmTimeout: config.llm.timeout_sec * 1000, imageTimeout: config.image.timeout_sec * 1000,
    });
    this.providers = {
      text: new OpenAiProvider({ ...options("text"), responseFormat: config.llm.provider === "deepseek" ? "json_object" : undefined }),
      vision: new OpenAiProvider({ ...options("vision"), responseFormat: config.review.provider === "deepseek" ? "json_object" : undefined }),
      image: config.image.provider === "openai" ? new OpenAiProvider(options("image")) : new NativeImageProvider(config.image.provider, options("image")),
    };
  }

  ready(kind: AiKind = "text"): void { this.providers[kind].ready(); }
  structured(request: StructuredRequest) { return this.providers[request.images?.length ? "vision" : "text"].structured(request); }
  image(request: ImageRequest) { return this.providers.image.image(request); }
}

interface ProviderFailure { code?: string; message?: string }
interface SeedreamResponse {
  data?: { b64_json?: string; url?: string; error?: ProviderFailure }[];
  error?: ProviderFailure;
  usage?: { generated_images?: number; output_tokens?: number };
}
interface QwenResponse {
  output?: { choices?: { message?: { content?: { image?: string }[] } }[] };
  code?: string;
  message?: string;
  usage?: { image_count?: number };
}

class NativeImageProvider extends OpenAiProvider {
  constructor(private readonly provider: "seedream" | "qwen", options: ConstructorParameters<typeof OpenAiProvider>[0]) { super(options); }

  override async image(request: ImageRequest) {
    this.ready();
    const options = { signal: request.signal, timeout: this.options.imageTimeout };
    const images = request.images.map((image) => `data:image/png;base64,${encodeBase64(image.data)}`);
    let encoded: string | undefined;
    let url: string | undefined;
    let usage: TokenUsage | undefined;
    let failure: ProviderFailure | undefined;
    if (this.provider === "seedream") {
      const response = await this.response<SeedreamResponse>(this.client.post("/images/generations", {
        ...options, body: {
          model: request.model, prompt: request.prompt, size: request.size,
          response_format: "b64_json", watermark: false,
          ...(images.length ? { image: images } : {}),
        },
      }));
      encoded = response.data?.[0]?.b64_json;
      url = response.data?.[0]?.url;
      failure = response.error ?? response.data?.[0]?.error;
      usage = response.usage ? { input_tokens: 0, output_tokens: response.usage.output_tokens ?? 0, image_count: response.usage.generated_images } : undefined;
    } else {
      const response = await this.response<QwenResponse>(this.client.post("/services/aigc/multimodal-generation/generation", {
        ...options, body: {
          model: request.model,
          input: { messages: [{ role: "user", content: [...images.map((image) => ({ image })), { text: request.prompt }] }] },
          parameters: { size: request.size.replace("x", "*"), n: 1, watermark: false, prompt_extend: false },
        },
      }));
      usage = response.usage ? { input_tokens: 0, output_tokens: 0, image_count: response.usage.image_count } : undefined;
      failure = response.code ? { code: response.code, message: response.message } : undefined;
      const content = response.output?.choices?.[0]?.message?.content;
      url = Array.isArray(content) ? content.find((item) => item?.image)?.image : undefined;
    }
    if (failure) throw Object.assign(new Error(`${failure.code}: ${failure.message}`.split(this.options.apiKey!).join("[redacted]")), { status: 400, code: failure.code });
    try {
      let data: Uint8Array;
      if (encoded) data = decodeBase64(encoded);
      else if (url) {
        const signal = AbortSignal.any([AbortSignal.timeout(this.options.imageTimeout), ...(request.signal ? [request.signal] : [])]);
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}`);
        data = new Uint8Array(await response.arrayBuffer());
      } else throw new Error("Image response did not contain image data");
      if (data[0] === 0xff && data[1] === 0xd8) {
        const decoded = jpeg.decode(data);
        const image = new PNG({ width: decoded.width, height: decoded.height });
        image.data = decoded.data;
        data = new Uint8Array(PNG.sync.write(image));
      }
      return { data, usage };
    } catch {
      throw new ImageResponseError("Generated image could not be downloaded or decoded; fees remain recorded", usage);
    }
  }
}
