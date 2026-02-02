/**
 * Deno Text-to-Speech Starter - Backend Server
 *
 * This is a simple Deno HTTP server that provides a text-to-speech API endpoint
 * powered by Deepgram's Text-to-Speech service. It's designed to be easily
 * modified and extended for your own projects.
 *
 * Key Features:
 * - API endpoint: POST /tts/synthesize
 * - Accepts text in body and model as query parameter
 * - Returns binary audio data (application/octet-stream)
 * - Proxies to Vite dev server in development
 * - Serves static frontend in production
 * - Native TypeScript support
 * - No external web framework needed
 */

import { createClient } from "@deepgram/sdk";
import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";

// Load environment variables
await load({ export: true });

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Default text-to-speech model to use when none is specified
 * Options: "aura-2-thalia-en", "aura-2-theia-en", "aura-2-andromeda-en", etc.
 * See: https://developers.deepgram.com/docs/text-to-speech-models
 */
const DEFAULT_MODEL = "aura-2-thalia-en";

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
  vitePort: number;
  isDevelopment: boolean;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8080"),
  host: Deno.env.get("HOST") || "0.0.0.0",
  vitePort: parseInt(Deno.env.get("VITE_PORT") || "8081"),
  isDevelopment: Deno.env.get("NODE_ENV") === "development",
};

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables
 */
function loadApiKey(): string {
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");

  if (!apiKey) {
    console.error("\n❌ ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    Deno.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// SETUP - Initialize Deepgram client
// ============================================================================

const deepgram = createClient(apiKey);

// ============================================================================
// TYPES - TypeScript interfaces for request/response
// ============================================================================

interface ErrorResponse {
  error: {
    type: "ValidationError" | "SynthesisError";
    code: string;
    message: string;
    details: {
      originalError: string;
    };
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates text-to-speech input
 */
function validateTtsInput(text: string | null): string | null {
  if (!text || typeof text !== "string") {
    return "text field is required and must be a string";
  }
  if (text.trim().length === 0) {
    return "text cannot be empty";
  }
  return null;
}

/**
 * Formats error responses in a consistent structure
 */
function formatErrorResponse(
  error: Error,
  statusCode: number = 500,
  code?: string
): Response {
  const errorBody: ErrorResponse = {
    error: {
      type: statusCode === 400 ? "ValidationError" : "SynthesisError",
      code: code || (statusCode === 400 ? "INVALID_INPUT" : "SYNTHESIS_FAILED"),
      message: error.message || "An error occurred during synthesis",
      details: {
        originalError: error.toString(),
      },
    },
  };

  return Response.json(errorBody, { status: statusCode });
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * POST /tts/synthesize
 * Main text-to-speech endpoint
 */
async function handleSynthesis(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const text = body.text;
    const url = new URL(req.url);
    const model = url.searchParams.get("model") || DEFAULT_MODEL;

    // Validate input
    const validationError = validateTtsInput(text);
    if (validationError) {
      return formatErrorResponse(
        new Error(validationError),
        400,
        "INVALID_INPUT"
      );
    }

    // Send synthesis request to Deepgram
    const response = await deepgram.speak.request(
      { text },
      {
        model,
      }
    );

    // Get audio stream
    const stream = await response.getStream();
    if (!stream) {
      throw new Error("No audio stream returned from Deepgram");
    }

    // Convert stream to Uint8Array
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const audioData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      audioData.set(chunk, offset);
      offset += chunk.length;
    }

    // Return audio data
    return new Response(audioData, {
      headers: {
        "content-type": "application/octet-stream",
      },
    });
  } catch (err) {
    console.error("Synthesis error:", err);
    return formatErrorResponse(err as Error);
  }
}

/**
 * GET /api/metadata
 * Returns metadata about this starter application
 */
async function handleMetadata(): Promise<Response> {
  try {
    const tomlContent = await Deno.readTextFile("./deepgram.toml");
    const config = TOML.parse(tomlContent);

    if (!config.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500 }
      );
    }

    return Response.json(config.meta);
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// FRONTEND SERVING - Development proxy or production static files
// ============================================================================

/**
 * Get content type based on file extension
 */
function getContentType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return types[ext || ""] || "application/octet-stream";
}

/**
 * Serve static file from frontend/dist
 */
async function serveStaticFile(pathname: string): Promise<Response> {
  const filePath = pathname === "/"
    ? "./frontend/dist/index.html"
    : `./frontend/dist${pathname}`;

  try {
    const file = await Deno.readFile(filePath);
    const contentType = getContentType(filePath);
    return new Response(file, {
      headers: { "content-type": contentType },
    });
  } catch {
    // Return index.html for SPA routing (404s -> index.html)
    try {
      const index = await Deno.readFile("./frontend/dist/index.html");
      return new Response(index, {
        headers: { "content-type": "text/html" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}

/**
 * Handle frontend requests - proxy to Vite in dev, serve static in prod
 */
async function handleFrontend(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (config.isDevelopment) {
    // Proxy to Vite dev server
    const viteUrl = `http://localhost:${config.vitePort}${url.pathname}${url.search}`;

    try {
      const response = await fetch(viteUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return response;
    } catch {
      return new Response(
        `Vite dev server not running on port ${config.vitePort}`,
        { status: 502 }
      );
    }
  }

  // Production mode - serve static files
  return serveStaticFile(url.pathname);
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // API Routes
  if (req.method === "POST" && url.pathname === "/tts/synthesize") {
    return handleSynthesis(req);
  }

  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // Frontend (catch-all)
  return handleFrontend(req);
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`🚀 Deno Text-to-Speech Server running at http://localhost:${config.port}`);
if (config.isDevelopment) {
  console.log(`📡 Proxying frontend from Vite dev server on port ${config.vitePort}`);
  console.log(`\n⚠️  Open your browser to http://localhost:${config.port}`);
} else {
  console.log(`📦 Serving built frontend from frontend/dist`);
}
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
