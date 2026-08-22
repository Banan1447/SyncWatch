/**
 * project-mcp — HTTP/SSE MCP server for SyncWatch
 *
 * Exposes project file tools (read, write, list, search, docker).
 *
 * Transport: Streamable HTTP on POST /mcp  (MCP SDK >= 1.1 StreamableHTTP)
 * Fallback:  SSE on GET /sse + POST /messages  (legacy clients)
 */

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const PORT = parseInt(process.env.PORT ?? "3333", 10);
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? "/project";
const DOCKER_SOCK = "/var/run/docker.sock";

// ─── helpers ─────────────────────────────────────────────────────────────────

function safePath(rel) {
  const abs = path.resolve(PROJECT_ROOT, rel.replace(/^\/+/, ""));
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error("Path traversal denied");
  return abs;
}

function dockerRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: DOCKER_SOCK,
      method,
      path: urlPath,
      headers: body ? { "Content-Type": "application/json" } : {},
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function walkSearch(dir, ext, regex, results) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
      await walkSearch(full, ext, regex, results);
    } else if (e.isFile() && (!ext || e.name.endsWith(ext))) {
      try {
        const content = await fs.readFile(full, "utf8");
        content.split("\n").forEach((line, i) => {
          if (regex.test(line)) results.push(`${path.relative(PROJECT_ROOT, full)}:${i + 1}: ${line.trim()}`);
        });
      } catch {}
    }
  }
}

// ─── MCP server ───────────────────────────────────────────────────────────────

function makeMcpServer() {
  const server = new McpServer({ name: "project-mcp", version: "1.0.0" });

  server.registerTool("read_file", {
    description: "Read a file from the SyncWatch project. Path relative to project root.",
    inputSchema: { path: z.string().describe("Relative path, e.g. services/auth/main.go") },
  }, async ({ path: p }) => {
    const content = await fs.readFile(safePath(p), "utf8");
    return { content: [{ type: "text", text: content }] };
  });

  server.registerTool("write_file", {
    description: "Write (create or overwrite) a file in the project.",
    inputSchema: { path: z.string(), content: z.string() },
  }, async ({ path: p, content }) => {
    const abs = safePath(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return { content: [{ type: "text", text: `Written ${p} (${content.length} bytes)` }] };
  });

  server.registerTool("list_directory", {
    description: "List files and folders in a project directory.",
    inputSchema: { path: z.string().describe("Relative path; empty string for root") },
  }, async ({ path: p }) => {
    const abs = safePath(p || "");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const list = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n");
    return { content: [{ type: "text", text: list }] };
  });

  server.registerTool("search_files", {
    description: "Search for a regex pattern across project files.",
    inputSchema: {
      pattern: z.string(),
      dir: z.string().optional(),
      extension: z.string().optional(),
    },
  }, async ({ pattern, dir, extension }) => {
    const results = [];
    await walkSearch(safePath(dir || ""), extension || "", new RegExp(pattern, "i"), results);
    return { content: [{ type: "text", text: results.slice(0, 200).join("\n") || "(no matches)" }] };
  });

  server.registerTool("get_project_context", {
    description: "Read CLAUDE.md — full project context, architecture, services, and conventions.",
    inputSchema: {},
  }, async () => {
    const content = await fs.readFile(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    return { content: [{ type: "text", text: content }] };
  });

  server.registerTool("docker_containers", {
    description: "List all Docker containers (name, state, status).",
    inputSchema: {},
  }, async () => {
    const res = await dockerRequest("GET", "/containers/json?all=1", null);
    if (res.status !== 200) return { content: [{ type: "text", text: `Docker error ${res.status}` }] };
    const list = JSON.stringify(
      res.body.map((c) => ({
        id: c.Id.slice(0, 12),
        name: (c.Names[0] || "").replace(/^\//, ""),
        state: c.State,
        status: c.Status,
      })),
      null, 2
    );
    return { content: [{ type: "text", text: list }] };
  });

  return server;
}

// ─── Express app (HTTP + SSE transports) ─────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const httpSessions = new Map();
const sseSessions = new Map();
const pendingCodes = new Map();

// ── OAuth 2.0 (required by Claude Code for HTTP MCP servers) ─────────────────

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const base = `http://localhost:${PORT}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

app.post("/register", (req, res) => {
  res.status(201).json({
    client_id: `local-${crypto.randomUUID()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: req.body?.redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

app.get("/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge } = req.query;
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
  const code = crypto.randomUUID();
  pendingCodes.set(code, { code_challenge });
  setTimeout(() => pendingCodes.delete(code), 300_000);
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

app.post("/token", (req, res) => {
  res.json({
    access_token: `tok-${crypto.randomUUID()}`,
    token_type: "Bearer",
    expires_in: 86400,
  });
});

// ── Streamable HTTP (primary) ──
app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }
  const server = makeMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => { httpSessions.set(id, { server, transport }); },
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── Legacy SSE transport ──
app.get("/sse", async (req, res) => {
  const sessionId = crypto.randomUUID();
  const server = makeMcpServer();
  const transport = new SSEServerTransport(`/messages?sessionId=${sessionId}`, res);
  sseSessions.set(sessionId, transport);
  res.on("close", () => sseSessions.delete(sessionId));
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  const transport = sseSessions.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "project-mcp", project_root: PROJECT_ROOT })
);

app.listen(PORT, () => {
  console.log(`project-mcp listening on :${PORT}`);
  console.log(`  Project root: ${PROJECT_ROOT}`);
  console.log(`  Endpoints: POST /mcp  |  GET /sse  |  POST /messages  |  GET /health`);
});
