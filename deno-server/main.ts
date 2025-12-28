import { Application, Router, Context } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { load } from "https://deno.land/std@0.208.0/dotenv/mod.ts";

// Load environment variables
const env = await load({ envPath: ".env", allowEmptyValues: true });

// --- Configuration ---
const config = {
  APP_NAME: env.APP_NAME || "googletranslate-2api",
  APP_VERSION: env.APP_VERSION || "1.0.0",
  DESCRIPTION: env.DESCRIPTION || "A proxy that converts Google Translate API to OpenAI-compatible format.",
  API_MASTER_KEY: env.API_MASTER_KEY || null,
  PORT: parseInt(env.PORT || env.NGINX_PORT || "8088"),
  GOOGLE_API_KEY: env.GOOGLE_API_KEY || null,
  API_REQUEST_TIMEOUT: parseInt(env.API_REQUEST_TIMEOUT || "60000"),
  DEFAULT_MODEL: env.DEFAULT_MODEL || "google-translate",
  KNOWN_MODELS: ["google-translate"],
};

// --- Logger ---
const log = {
  info: (msg: string) => console.log(`\x1b[32m${new Date().toISOString()}\x1b[0m | \x1b[36mINFO\x1b[0m | ${msg}`),
  error: (msg: string) => console.error(`\x1b[32m${new Date().toISOString()}\x1b[0m | \x1b[31mERROR\x1b[0m | ${msg}`),
};

// --- SSE Utils ---
const DONE_CHUNK = "data: [DONE]\n\n";

function createSseData(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function createChatCompletionChunk(
  requestId: string,
  model: string,
  content: string,
  finishReason: string | null = null
): Record<string, unknown> {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}


// --- Google Translate Provider ---
const TRANSLATE_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
const CHINESE_REGEX = /[\u4e00-\u9fa5]/;

function prepareHeaders(): Record<string, string> {
  return {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json+protobuf",
    "Origin": "https://stackoverflow.ai",
    "Referer": "https://stackoverflow.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "x-goog-api-key": config.GOOGLE_API_KEY!,
  };
}

function preparePayload(requestData: Record<string, unknown>): unknown[] {
  const messages = requestData.messages as Array<{ role: string; content: string }> || [];
  const lastMessage = messages[messages.length - 1];
  
  if (!messages.length || lastMessage?.role !== "user") {
    throw new Error("Missing valid user message in request.");
  }

  const textToTranslate = lastMessage.content || "";
  const sourceLang = (requestData.source_lang as string) || "auto";
  const targetLang = (requestData.target_lang as string) || "en";

  log.info(`Translation: source=${sourceLang}, target=${targetLang}, text="${textToTranslate.substring(0, 50)}..."`);

  return [[[textToTranslate], sourceLang, targetLang], "te_lib"];
}

function stripHtml(html: string): string {
  // Simple HTML to text conversion
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u200b/g, ""); // Remove zero-width spaces
}

async function* streamTranslation(requestData: Record<string, unknown>): AsyncGenerator<string> {
  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  const modelName = (requestData.model as string) || config.DEFAULT_MODEL;

  try {
    const headers = prepareHeaders();
    const payload = preparePayload(requestData);

    log.info(`Sending translation request: ${JSON.stringify(payload)}`);

    const response = await fetch(TRANSLATE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    log.info(`Upstream response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`Upstream error: ${response.status} ${response.statusText}`);
    }

    const responseData = await response.json();
    log.info(`Received upstream response: ${JSON.stringify(responseData)}`);

    let translatedHtml = "";
    if (Array.isArray(responseData) && responseData.length > 0) {
      if (Array.isArray(responseData[0]) && responseData[0].length > 0) {
        translatedHtml = responseData[0][0];
      }
    } else if (!Array.isArray(responseData)) {
      throw new Error(`Unexpected response format: ${JSON.stringify(responseData)}`);
    }

    const cleanText = stripHtml(translatedHtml);

    yield createSseData(createChatCompletionChunk(requestId, modelName, cleanText));
    yield createSseData(createChatCompletionChunk(requestId, modelName, "", "stop"));
    yield DONE_CHUNK;
  } catch (e) {
    log.error(`Translation error: ${e}`);
    const errorMessage = `Internal server error: ${e}`;
    yield createSseData(createChatCompletionChunk(requestId, modelName, errorMessage, "stop"));
    yield DONE_CHUNK;
  }
}


// --- Middleware: API Key Verification ---
async function verifyApiKey(ctx: Context, next: () => Promise<unknown>) {
  if (config.API_MASTER_KEY && config.API_MASTER_KEY !== "1") {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().includes("bearer")) {
      ctx.response.status = 401;
      ctx.response.body = { detail: "Bearer Token authentication required." };
      return;
    }
    const token = authHeader.split(" ").pop();
    if (token !== config.API_MASTER_KEY) {
      ctx.response.status = 403;
      ctx.response.body = { detail: "Invalid API Key." };
      return;
    }
  }
  await next();
}

// --- Routes ---
const router = new Router();

router.get("/", (ctx) => {
  ctx.response.body = {
    message: `Welcome to ${config.APP_NAME} v${config.APP_VERSION}. Service is running normally.`,
  };
});

router.get("/v1/models", verifyApiKey, (ctx) => {
  ctx.response.body = {
    object: "list",
    data: config.KNOWN_MODELS.map((name) => ({
      id: name,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "Kira",
    })),
  };
});

router.post("/v1/chat/completions", verifyApiKey, async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;

    ctx.response.headers.set("Content-Type", "text/event-stream");
    ctx.response.headers.set("Cache-Control", "no-cache");
    ctx.response.headers.set("Connection", "keep-alive");

    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of streamTranslation(body)) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    ctx.response.body = stream;
  } catch (e) {
    log.error(`Chat completions error: ${e}`);
    ctx.response.status = 500;
    ctx.response.body = { detail: `Internal server error: ${e}` };
  }
});

// --- Application Setup ---
const app = new Application();

// CORS middleware
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }
  
  await next();
});

app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  log.info(`${ctx.request.method} ${ctx.request.url.pathname} - ${ms}ms`);
});

app.use(router.routes());
app.use(router.allowedMethods());

// --- Startup ---
if (!config.GOOGLE_API_KEY) {
  log.error("GOOGLE_API_KEY is not configured. Please set it in .env file.");
  Deno.exit(1);
}

log.info(`${config.APP_NAME} v${config.APP_VERSION} starting...`);
log.info(`Server listening on http://localhost:${config.PORT}`);

await app.listen({ port: config.PORT });
