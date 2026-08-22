/**
 * obsidian-mcp — stdio MCP server for Obsidian vault interaction
 *
 * Requires the "Local REST API" Obsidian plugin (default port 27124).
 * Config via environment variables:
 *   OBSIDIAN_API_KEY  — plugin API key (required)
 *   OBSIDIAN_HOST     — default 127.0.0.1
 *   OBSIDIAN_PORT     — default 27124
 */

import https from "node:https";
import http  from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY  = process.env.OBSIDIAN_API_KEY ?? "";
const HOST     = process.env.OBSIDIAN_HOST ?? "127.0.0.1";
const PORT     = parseInt(process.env.OBSIDIAN_PORT ?? "27124", 10);
// Port 27124 is HTTPS (self-signed cert), 27123 is HTTP
const PROTOCOL = PORT === 27123 ? "http" : "https";
const BASE     = `${PROTOCOL}://${HOST}:${PORT}`;

if (!API_KEY) {
  process.stderr.write("obsidian-mcp: OBSIDIAN_API_KEY is not set\n");
}

// Self-signed cert agent for the Obsidian Local REST API plugin
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function obsidianFetch(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = PROTOCOL === "https";
    const driver  = isHttps ? https : http;

    const bodyStr = body === undefined
      ? undefined
      : typeof body === "string" ? body : JSON.stringify(body);
    const isJson = body !== undefined && typeof body !== "string";

    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": isJson ? "application/json" : "text/markdown",
      ...extraHeaders,
    };
    if (bodyStr !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const opts = {
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method,
      headers,
      ...(isHttps ? { agent: httpsAgent } : {}),
    };

    const req = driver.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 204) return resolve(null);
        if (res.statusCode >= 400) {
          let detail = text;
          try { detail = JSON.parse(text)?.message ?? text; } catch {}
          return reject(new Error(`Obsidian API ${res.statusCode}: ${detail}`));
        }
        const ct = res.headers["content-type"] ?? "";
        if (ct.includes("application/json")) {
          try { return resolve(JSON.parse(text)); } catch {}
        }
        resolve(text);
      });
    });

    req.on("error", (err) => reject(new Error(`Cannot reach Obsidian at ${BASE}: ${err.message}`)));
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// ─── Result helpers ───────────────────────────────────────────────────────────

function ok(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function fail(err) {
  return { isError: true, content: [{ type: "text", text: err.message ?? String(err) }] };
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "obsidian-mcp",
  version: "1.0.0",
});

// ── vault_list ────────────────────────────────────────────────────────────────
server.registerTool("vault_list", {
  description: "List files and folders at a path inside the Obsidian vault. Returns one entry per line; directories end with /.",
  inputSchema: {
    path: z.string().optional().describe("Vault-relative path (e.g. 'docs/') — omit or pass '' for the root."),
  },
}, async ({ path = "" }) => {
  try {
    const url = `/vault/${path.replace(/^\//, "")}`;
    const res = await obsidianFetch("GET", url.endsWith("/") || path === "" ? (url.endsWith("/") ? url : url + "/") : url + "/");
    const files = res?.files ?? [];
    return ok(files.join("\n") || "(empty)");
  } catch (err) {
    return fail(err);
  }
});

// ── note_read ─────────────────────────────────────────────────────────────────
server.registerTool("note_read", {
  description: "Read the full markdown content of an Obsidian note.",
  inputSchema: {
    path: z.string().describe("Vault-relative path to the note, e.g. 'folder/My Note.md'"),
  },
}, async ({ path }) => {
  try {
    const content = await obsidianFetch("GET", `/vault/${path.replace(/^\//, "")}`);
    return ok(content);
  } catch (err) {
    return fail(err);
  }
});

// ── note_write ────────────────────────────────────────────────────────────────
server.registerTool("note_write", {
  description: "Create or fully overwrite an Obsidian note with the given markdown content.",
  inputSchema: {
    path:    z.string().describe("Vault-relative path, e.g. 'folder/My Note.md'"),
    content: z.string().describe("Full markdown content to write"),
  },
}, async ({ path, content }) => {
  try {
    await obsidianFetch("PUT", `/vault/${path.replace(/^\//, "")}`, content);
    return ok(`Note written: ${path}`);
  } catch (err) {
    return fail(err);
  }
});

// ── note_append ───────────────────────────────────────────────────────────────
server.registerTool("note_append", {
  description: "Append text to the end of an existing Obsidian note (creates the note if it does not exist).",
  inputSchema: {
    path:    z.string().describe("Vault-relative path, e.g. 'folder/My Note.md'"),
    content: z.string().describe("Markdown text to append"),
  },
}, async ({ path, content }) => {
  try {
    await obsidianFetch("POST", `/vault/${path.replace(/^\//, "")}`, content);
    return ok(`Appended to: ${path}`);
  } catch (err) {
    return fail(err);
  }
});

// ── note_delete ───────────────────────────────────────────────────────────────
server.registerTool("note_delete", {
  description: "Permanently delete a note from the Obsidian vault.",
  inputSchema: {
    path: z.string().describe("Vault-relative path to the note to delete"),
  },
}, async ({ path }) => {
  try {
    await obsidianFetch("DELETE", `/vault/${path.replace(/^\//, "")}`);
    return ok(`Deleted: ${path}`);
  } catch (err) {
    return fail(err);
  }
});

// ── vault_search ──────────────────────────────────────────────────────────────
server.registerTool("vault_search", {
  description: "Full-text search across the Obsidian vault. Returns matching notes with surrounding context.",
  inputSchema: {
    query:          z.string().describe("Search query string"),
    context_length: z.number().int().min(0).max(1000).optional().describe("Characters of context around each match (default 100)"),
  },
}, async ({ query, context_length = 100 }) => {
  try {
    const results = await obsidianFetch(
      "POST",
      `/search/simple/?query=${encodeURIComponent(query)}&contextLength=${context_length}`,
    );
    if (!results || results.length === 0) return ok("(no results)");
    const lines = results.map((r) => {
      const matches = (r.matches ?? [])
        .map((m) => `    …${m.context}…`)
        .join("\n");
      return `${r.filename}\n${matches}`;
    });
    return ok(lines.join("\n\n"));
  } catch (err) {
    return fail(err);
  }
});

// ── active_note ───────────────────────────────────────────────────────────────
server.registerTool("active_note", {
  description: "Get the content of the note currently open/active in Obsidian.",
  inputSchema: {},
}, async () => {
  try {
    const content = await obsidianFetch("GET", "/active/");
    return ok(content);
  } catch (err) {
    return fail(err);
  }
});

// ── note_patch ────────────────────────────────────────────────────────────────
// Partially updates a note: YAML frontmatter fields and/or a named section.
server.registerTool("note_patch", {
  description: `Partially update an Obsidian note without rewriting it entirely.
Supports two patch modes (both optional, both applied if provided):
  1. frontmatter — update specific YAML frontmatter key-value pairs
  2. section — replace the body of a specific heading section

Examples:
  { path: "docs/FEATURE_x.md", frontmatter: { status: "done", progress: 100 } }
  { path: "docs/FEATURE_x.md", section: "## Реализовано", section_content: "- [x] Feature A" }
  `,
  inputSchema: {
    path: z.string().describe("Vault-relative path to the note, e.g. 'docs/FEATURE_x.md'"),
    frontmatter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
      .describe("Key-value pairs to set/update in YAML frontmatter. Existing keys are updated, new keys are added."),
    section: z.string().optional()
      .describe("Heading line to match (e.g. '## Реализовано'). The entire section body (until the next same-or-higher heading or EOF) is replaced."),
    section_content: z.string().optional()
      .describe("New content for the matched section (not including the heading line itself)."),
  },
}, async ({ path, frontmatter, section, section_content }) => {
  try {
    const raw = await obsidianFetch("GET", `/vault/${path.replace(/^\//, "")}`);
    if (typeof raw !== "string") throw new Error("Could not read note as text");

    let result = raw;

    // ── 1. Patch frontmatter ─────────────────────────────────────────────────
    if (frontmatter && Object.keys(frontmatter).length > 0) {
      const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) {
        // No frontmatter — prepend one
        const lines = Object.entries(frontmatter)
          .map(([k, v]) => `${k}: ${v === null ? "null" : JSON.stringify(v).replace(/^"|"$/g, "").replace(/\\"/g, '"')}`)
          .join("\n");
        result = `---\n${lines}\n---\n${result}`;
      } else {
        let fmBlock = fmMatch[1];
        for (const [key, value] of Object.entries(frontmatter)) {
          const valStr = value === null ? "null"
            : typeof value === "string" ? value
            : String(value);
          const re = new RegExp(`^(${key}\\s*:).*$`, "m");
          if (re.test(fmBlock)) {
            fmBlock = fmBlock.replace(re, `$1 ${valStr}`);
          } else {
            fmBlock += `\n${key}: ${valStr}`;
          }
        }
        result = result.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${fmBlock}\n---`);
      }
    }

    // ── 2. Patch section ─────────────────────────────────────────────────────
    if (section !== undefined && section_content !== undefined) {
      // Determine heading level of the target section
      const levelMatch = section.match(/^(#{1,6})\s/);
      const targetLevel = levelMatch ? levelMatch[1].length : 1;

      // Escape regex special chars in section heading
      const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Match the heading line + everything until the next heading of same or higher level (or EOF)
      const sectionRe = new RegExp(
        `(^${escapedSection}[\\t ]*)\\r?\\n([\\s\\S]*?)(?=\\n#{1,${targetLevel}}\\s|$)`,
        "m"
      );

      if (sectionRe.test(result)) {
        result = result.replace(sectionRe, (_, heading) => {
          const content = section_content.startsWith("\n") ? section_content : "\n" + section_content;
          return `${heading}${content}`;
        });
      } else {
        // Section not found — append at end
        result = result.trimEnd() + `\n\n${section}\n${section_content}\n`;
      }
    }

    if (result === raw) return ok("No changes (patch resulted in identical content)");

    await obsidianFetch("PUT", `/vault/${path.replace(/^\//, "")}`, result);
    return ok(`Patched: ${path}`);
  } catch (err) {
    return fail(err);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
