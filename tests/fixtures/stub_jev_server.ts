/**
 * In-process stub of the TypeSafe Jev endpoint.
 *
 * Answers every POST with a Jev-shaped reply (`{ model, answers, usage }`) and
 * records each request (method, headers, parsed body) so a test can assert the
 * bearer token and the exact `questions` map that was sent. It never inspects
 * or requires a real API key, and it binds an ephemeral port so tests can run
 * in parallel with anything else on the machine.
 */

import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface JevStubRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON body, or the raw string when the body was not JSON. */
  body: unknown;
  rawBody: string;
}

export interface JevStubReply {
  /** `answers` object placed in the JSON reply; defaults to `{}`. */
  answers?: Record<string, unknown>;
  /** `model` field of the JSON reply. */
  model?: string;
  /** `usage` field of the JSON reply. */
  usage?: Record<string, unknown>;
  /** HTTP status; defaults to 200. */
  status?: number;
  /** Wait before responding, to exercise a client's own timeout. */
  delayMs?: number;
  /** Send a non-JSON body instead of the JSON reply. */
  malformed?: boolean;
  /** Send this body verbatim, overriding every other field. */
  body?: string;
}

export interface StubJevServer {
  /** Origin of the stub, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Every request the stub received, in arrival order. */
  requests: JevStubRequest[];
  /** Replace the reply used for subsequent requests. */
  respond(reply: JevStubReply): void;
  /** Destroy open sockets and stop listening. Idempotent. */
  close(): Promise<void>;
}

/** Start the stub on an ephemeral localhost port. */
export async function start(reply: JevStubReply = {}): Promise<StubJevServer> {
  let current: JevStubReply = reply;
  const requests: JevStubRequest[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: unknown = rawBody;
      try {
        body = rawBody === "" ? null : JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
        rawBody,
      });

      const send = (): void => {
        const status = current.status ?? 200;
        if (current.body !== undefined) {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(current.body);
          return;
        }
        if (current.malformed === true) {
          response.writeHead(status, { "Content-Type": "text/plain" });
          response.end("this is not json");
          return;
        }
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: current.model ?? "jev-stub",
            answers: current.answers ?? {},
            usage: current.usage ?? { input_tokens: 1, output_tokens: 1 },
          }),
        );
      };

      if (current.delayMs !== undefined && current.delayMs > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          send();
        }, current.delayMs);
        timers.add(timer);
        response.on("close", () => clearTimeout(timer));
        return;
      }
      send();
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respond(next: JevStubReply): void {
      current = next;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Alias kept for readability at call sites. */
export const startStubJevServer = start;
