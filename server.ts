/**
 * Deno Text-to-Speech Starter - Backend Server
 *
 * This is a simple Deno HTTP server that provides a text-to-speech API endpoint
 * powered by Deepgram's Text-to-Speech service. It's designed to be easily
 * modified and extended for your own projects.
 *
 * Key Features:
 * - API endpoint: POST /api/text-to-speech
 * - Accepts text in body and model as query parameter
 * - Returns binary audio data (application/octet-stream)
 * - JWT session auth with page nonce (production only)
 * - CORS-enabled for frontend on port 8080
 * - Native TypeScript support
 * - No external web framework needed
 */

import { createClient } from "@deepgram/sdk";
import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";
import * as jose from "jose";

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
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens with page nonce for production security
// ============================================================================

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const REQUIRE_NONCE = !!Deno.env.get("SESSION_SECRET");
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

const sessionNonces = new Map<string, number>();
const NONCE_TTL_MS = 5 * 60 * 1000;
const JWT_EXPIRY = "1h";

/**
 * Generates a single-use nonce and stores it with an expiry
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates and consumes a nonce (single-use). Returns true if valid.
 */
function consumeNonce(nonce: string): boolean {
  const expiry = sessionNonces.get(nonce);
  if (!expiry) return false;
  sessionNonces.delete(nonce);
  return Date.now() < expiry;
}

// Clean up expired nonces every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiry] of sessionNonces) {
    if (now >= expiry) sessionNonces.delete(nonce);
  }
}, 60_000);

let indexHtmlTemplate: string | null = null;
try {
  indexHtmlTemplate = await Deno.readTextFile(
    new URL("./frontend/dist/index.html", import.meta.url).pathname
  );
} catch {
  // No built frontend (dev mode)
}

/**
 * Creates a signed JWT session token
 */
async function createSessionToken(): Promise<string> {
  return await new jose.SignJWT({ iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(JWT_EXPIRY)
    .sign(SESSION_SECRET_KEY);
}

/**
 * Verifies a JWT session token
 */
async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jose.jwtVerify(token, SESSION_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

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
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Nonce",
  };
}

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

  return Response.json(errorBody, {
    status: statusCode,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * Serve index.html with injected session nonce (production only)
 */
function handleServeIndex(): Response {
  if (!indexHtmlTemplate) {
    return new Response("Frontend not built. Run make build first.", { status: 404 });
  }
  // Cleanup expired nonces
  const now = Date.now();
  for (const [nonce, expiry] of sessionNonces) {
    if (now >= expiry) sessionNonces.delete(nonce);
  }
  const nonce = generateNonce();
  sessionNonces.set(nonce, Date.now() + NONCE_TTL_MS);
  const html = indexHtmlTemplate.replace(
    "</head>",
    `<meta name="session-nonce" content="${nonce}">\n</head>`
  );
  return new Response(html, {
    headers: { "Content-Type": "text/html", ...getCorsHeaders() },
  });
}

/**
 * GET /api/session
 * Issues a JWT. In production, requires valid nonce via X-Session-Nonce header.
 */
async function handleGetSession(req: Request): Promise<Response> {
  if (REQUIRE_NONCE) {
    const nonce = req.headers.get("X-Session-Nonce");
    if (!nonce || !consumeNonce(nonce)) {
      return Response.json(
        { error: { type: "AuthenticationError", code: "INVALID_NONCE", message: "Valid session nonce required. Please refresh the page." } },
        { status: 403, headers: getCorsHeaders() }
      );
    }
  }
  const token = await createSessionToken();
  return Response.json({ token }, { headers: getCorsHeaders() });
}

/**
 * Validates JWT from Authorization header. Returns error Response or null if OK.
 */
async function checkAuth(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return Response.json(
      { error: { type: "AuthenticationError", code: "MISSING_TOKEN", message: "Authorization header with Bearer token is required" } },
      { status: 401, headers: getCorsHeaders() }
    );
  }
  const token = authHeader.slice(7);
  if (!(await verifySessionToken(token))) {
    return Response.json(
      { error: { type: "AuthenticationError", code: "INVALID_TOKEN", message: "Invalid or expired session token" } },
      { status: 401, headers: getCorsHeaders() }
    );
  }
  return null;
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * POST /api/text-to-speech
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
        ...getCorsHeaders(),
      },
    });
  } catch (err) {
    console.error("Synthesis error:", err);
    const error = err as Error;
    const errorMsg = error.message.toLowerCase();

    // Check if it's a Deepgram text length error
    if (errorMsg.includes('too long') || errorMsg.includes('length') ||
        errorMsg.includes('limit') || errorMsg.includes('exceed')) {
      return formatErrorResponse(error, 400, 'TEXT_TOO_LONG');
    }

    return formatErrorResponse(error);
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
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(config.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session routes (unprotected)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return handleServeIndex();
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    return await handleGetSession(req);
  }

  // API Routes (auth required)
  if (req.method === "POST" && url.pathname === "/api/text-to-speech") {
    const authError = await checkAuth(req);
    if (authError) return authError;
    return handleSynthesis(req);
  }

  // Metadata (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: getCorsHeaders() }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

const nonceStatus = REQUIRE_NONCE ? " (nonce required)" : "";
console.log("\n" + "=".repeat(70));
console.log(`🚀 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`📡 GET  /api/session${nonceStatus}`);
console.log(`📡 POST /api/text-to-speech (auth required)`);
console.log(`📡 GET  /api/metadata`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
