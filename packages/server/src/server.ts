import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import {
  SystemOneProvider,
  VILLAGE_EDGES,
  VILLAGE_PLACES,
  explainLastDecision,
  formatExplainReport,
  type PartialSimConfig,
  type SimConfig,
} from "@village/core";
import { resolveFromInvocationCwd } from "./config-loader.ts";
import { LiveSimManager } from "./runner.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolveBody({} as T);
        return;
      }
      try {
        resolveBody(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export interface StartServerOptions {
  port: number;
  host?: string;
  config: SimConfig;
  tickMs?: number;
  autostart?: boolean;
  runsDir?: string;
  staticDir?: string;
}

export interface LiveServerHandle {
  server: Server;
  manager: LiveSimManager;
  url: string;
  close(): Promise<void>;
}

export async function startVillageServer(options: StartServerOptions): Promise<LiveServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const manager = new LiveSimManager(options.config, {
    tickMs: options.tickMs,
    runsDir: options.runsDir,
  });

  const staticDir = options.staticDir ?? resolveFromInvocationCwd("packages/web/dist");

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${options.port}`);
    const path = url.pathname;

    if (method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (method === "GET" && path === "/api/health") {
        const status = manager.getStatus();
        let systemOneHealth: { ok: boolean; status?: number; error?: string } | undefined;
        if (status.config.provider === "systemone") {
          const probe = new SystemOneProvider({
            endpoint: status.config.endpoint,
            model: status.config.model,
            timeoutMs: 3000,
            batch: "auto",
          });
          systemOneHealth = await probe.checkHealth();
        }
        sendJson(res, 200, { ok: true, status, systemOneHealth });
        return;
      }

      if (method === "GET" && path === "/api/state") {
        sendJson(res, 200, {
          places: VILLAGE_PLACES,
          edges: VILLAGE_EDGES,
          ...manager.getFullState(),
        });
        return;
      }

      if (method === "GET" && path === "/api/stream") {
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        const initPayload = JSON.stringify({
          type: "init",
          places: VILLAGE_PLACES,
          edges: VILLAGE_EDGES,
          ...manager.getFullState(),
        });
        res.write(`data: ${initPayload}\n\n`);

        const unsubscribe = manager.subscribe((msg) => {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        });

        const keepAlive = setInterval(() => {
          res.write(": ping\n\n");
        }, 15_000);

        req.on("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }

      if (method === "POST" && path === "/api/control/play") {
        manager.play();
        sendJson(res, 200, { status: manager.getStatus() });
        return;
      }

      if (method === "POST" && path === "/api/control/pause") {
        manager.pause();
        sendJson(res, 200, { status: manager.getStatus() });
        return;
      }

      if (method === "POST" && path === "/api/control/step") {
        const snapshot = await manager.stepOnce();
        sendJson(res, 200, { snapshot, status: manager.getStatus() });
        return;
      }

      if (method === "POST" && path === "/api/control/speed") {
        const body = await readJsonBody<{ tickMs?: number }>(req);
        if (typeof body.tickMs === "number") {
          manager.setSpeed(body.tickMs);
        }
        sendJson(res, 200, { status: manager.getStatus() });
        return;
      }

      if (method === "POST" && path === "/api/control/reset") {
        const body = await readJsonBody<PartialSimConfig>(req);
        manager.reset(body);
        sendJson(res, 200, manager.getFullState());
        return;
      }

      if (method === "GET" && path === "/api/runs") {
        sendJson(res, 200, { runs: manager.listSavedRuns() });
        return;
      }

      if (method === "POST" && path === "/api/runs/replay") {
        const body = await readJsonBody<{ filename?: string }>(req);
        if (!body.filename) {
          sendJson(res, 400, { error: "filename is required" });
          return;
        }
        manager.startReplay(body.filename);
        sendJson(res, 200, manager.getFullState());
        return;
      }

      if (method === "GET" && path.startsWith("/api/explain/")) {
        const entityId = decodeURIComponent(path.slice("/api/explain/".length));
        const record = explainLastDecision(manager.getDecisions(), entityId);
        if (!record) {
          sendJson(res, 404, { error: `No decisions found for entity ${entityId}` });
          return;
        }
        sendJson(res, 200, {
          record,
          report: formatExplainReport(record),
        });
        return;
      }

      // Optional static frontend serving when built
      if (method === "GET" && existsSync(staticDir)) {
        const relPath = path === "/" ? "index.html" : path.replace(/^\/+/, "");
        const target = join(staticDir, relPath);
        if (target.startsWith(staticDir) && existsSync(target) && statSync(target).isFile()) {
          const content = readFileSync(target);
          const mime = MIME_TYPES[extname(target)] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": mime });
          res.end(content);
          return;
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolveListen) => {
    server.listen(options.port, host, () => resolveListen());
  });

  if (options.autostart !== false) {
    manager.play();
  }

  const url = `http://${host}:${options.port}`;
  return {
    server,
    manager,
    url,
    close: () => {
      manager.pause();
      return new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
