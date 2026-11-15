// The Game contract over a pair of streams, one JSON message per line: a frontend in another process (or
// written in another language) sends requests and gets one response for each, in order.
//
//   → {"id": 1, "method": "open", "params": ["hollow-lantern", "continue"]}
//   ← {"id": 1, "result": {"lines": [...], "resumed": true, "view": {...}, "cast": {...}}}
//   ← {"id": 2, "error": {"message": "No campaign \"x\""}}
//
// Methods are Game's: library(), open(campaignId, mode), submit(text), close().
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Game, Library, Opened, TurnOutcome } from "./api.js";

export interface Request {
  id: number;
  method: keyof Game;
  params: unknown[];
}

export type Response = { id: number; result: unknown } | { id: number; error: { message: string } };

const METHODS: readonly (keyof Game)[] = ["library", "open", "submit", "close"];

/**
 * Answers requests from `input` on `output` with `game` (or the error it failed to start with), one at a time
 * so turns happen in the order they were sent. Ends `output` and resolves when the input ends or after close().
 */
export function serve(game: Promise<Game>, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  const send = (response: Response) => output.write(JSON.stringify(response) + "\n");
  return new Promise((resolve) => {
    lines.on("line", (line) => {
      if (!line.trim()) return;
      queue = queue.then(async () => {
        let request: Request;
        try {
          request = JSON.parse(line) as Request;
        } catch {
          return void send({ id: -1, error: { message: `Not JSON: ${line.slice(0, 80)}` } });
        }
        try {
          if (!METHODS.includes(request.method)) throw new Error(`No method "${request.method}"`);
          const engine = await game;
          const result = await (engine[request.method] as (...args: unknown[]) => Promise<unknown>)(...(request.params ?? []));
          send({ id: request.id, result: result ?? null });
          if (request.method === "close") lines.close();
        } catch (err) {
          send({ id: request.id, error: { message: err instanceof Error ? err.message : String(err) } });
        }
      });
    });
    // Done: answer what's queued, then end the output, which tells the other end there's no more.
    lines.on("close", () => void queue.then(() => output.end(resolve)));
  });
}

/** A Game served by serve() at the other end of a pair of streams. */
export class RemoteGame implements Game {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  /** Set once the connection is gone: every call fails with it from then on. */
  private broken?: Error;

  /** `ended`: the connection is over once `input` ends (otherwise, the owner calls disconnect()). */
  constructor(
    input: Readable,
    private readonly output: Writable,
    { ended = true }: { ended?: boolean } = {},
  ) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let response: Response;
      try {
        response = JSON.parse(line) as Response;
      } catch {
        return; // not for us: a stray line of output
      }
      const call = this.pending.get(response.id);
      if (!call) return;
      this.pending.delete(response.id);
      if ("error" in response) call.reject(new Error(response.error.message));
      else call.resolve(response.result);
    });
    if (ended) lines.on("close", () => this.disconnect(new Error("The game engine has stopped")));
  }

  /** Fails every call waiting on an answer, and every one after, with `err`. */
  disconnect(err: Error): void {
    this.broken ??= err;
    for (const call of this.pending.values()) call.reject(this.broken);
    this.pending.clear();
  }

  private call<T>(method: keyof Game, ...params: unknown[]): Promise<T> {
    if (this.broken) return Promise.reject(this.broken);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.output.write(JSON.stringify({ id, method, params } satisfies Request) + "\n");
    });
  }

  library(): Promise<Library> {
    return this.call("library");
  }

  open(campaignId: string, mode: "continue" | "new"): Promise<Opened> {
    return this.call("open", campaignId, mode);
  }

  submit(text: string): Promise<TurnOutcome> {
    return this.call("submit", text);
  }

  async close(): Promise<void> {
    if (this.broken) return;
    await this.call("close");
  }
}
