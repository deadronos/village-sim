import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ScriptedProvider, type Question } from "../src/index.ts";

export interface FakeSystemOneConfig {
  authToken?: string;
  failNextBatchWith500?: number;
  always500?: boolean;
  malformedQuestionId?: string;
  latencyMs?: number;
  choiceWeights?: readonly number[];
}

export interface FakeSystemOneHandle {
  url: string;
  endpoint: string;
  calls: Array<{ method: string; path: string; questionCount: number; auth?: string }>;
  config: FakeSystemOneConfig;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * Hermetic Node stdlib HTTP server implementing the System One wire contract
 * (/v1/models, /openapi.json, /v1/systemone) plus injectable 500 & malformed
 * answer faults (§14).
 */
export async function startFakeSystemOne(
  initialConfig: FakeSystemOneConfig = {},
): Promise<FakeSystemOneHandle> {
  const config: FakeSystemOneConfig = { ...initialConfig };
  const calls: FakeSystemOneHandle["calls"] = [];
  const helper = new ScriptedProvider();

  const server: Server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const auth = req.headers.authorization;

    if (config.authToken && auth !== `Bearer ${config.authToken}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (method === "GET" && path === "/v1/models") {
      calls.push({ method, path, questionCount: 0, auth });
      sendJson(res, 200, {
        data: [{ id: "kev-latest", object: "model" }],
      });
      return;
    }

    if (method === "GET" && path === "/openapi.json") {
      calls.push({ method, path, questionCount: 0, auth });
      sendJson(res, 200, {
        openapi: "3.1.0",
        info: { title: "Fake System One", version: "1.0.0" },
        paths: { "/v1/systemone": { post: { summary: "Typed decision endpoint" } } },
      });
      return;
    }

    if (method === "POST" && path === "/v1/systemone") {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as {
        model?: string;
        state?: string | Record<string, unknown>;
        questions?: Record<string, Question>;
      };
      const questions = parsed.questions ?? {};
      const qCount = Object.keys(questions).length;
      calls.push({ method, path, questionCount: qCount, auth });

      if (config.always500) {
        sendJson(res, 500, { error: "simulated internal error" });
        return;
      }

      if (qCount > 1 && (config.failNextBatchWith500 ?? 0) > 0) {
        config.failNextBatchWith500 = (config.failNextBatchWith500 ?? 1) - 1;
        sendJson(res, 500, { error: "simulated batch failure" });
        return;
      }

      const scripted = await helper.decide(parsed.state ?? "", questions, 1);
      const answers: Record<string, unknown> = {};
      for (const [qId, ans] of Object.entries(scripted.answers)) {
        if (config.malformedQuestionId === qId) {
          // Deliberately malformed answer (missing probabilities)
          answers[qId] = { type: "choice", choice: "invalid_option" };
        } else if (config.choiceWeights) {
          answers[qId] = {
            probabilities: Object.fromEntries(
              Object.keys(questions[qId]!.criteria).map((key, index) => [
                key,
                config.choiceWeights![index] ?? 0,
              ]),
            ),
          };
        } else {
          answers[qId] = ans;
        }
      }

      sendJson(res, 200, {
        model: parsed.model ?? "kev-latest",
        answers,
        latency_ms: config.latencyMs ?? 18,
      });
      return;
    }

    // Bare GET / returns 404 on System One servers (§5.3)
    sendJson(res, 404, { detail: "Not Found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    endpoint: `${url}/v1/systemone`,
    calls,
    config,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
