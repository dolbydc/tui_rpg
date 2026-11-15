import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR, DEFAULT_CONTENT_DIR } from "../config.js";
import type { GameEvent } from "../engine/api.js";
import { createGame } from "../engine/create.js";
import { RemoteGame, serve } from "../engine/protocol.js";
import { MockProvider } from "../llm/mock.js";
import { loadWorld } from "../world/loader.js";
import { ComfyPainter, type Painter } from "./comfy.js";
import { Illustrator, imagePrompt, portraitPrompt } from "./illustrator.js";

const world = await loadWorld(DEFAULT_CAMPAIGN_DIR);
const place = (id: string) => ({ kind: "place" as const, id });
const person = (id: string) => ({ kind: "person" as const, id });
const square = world.locations.get("village-square")!;
const PROMPT = "A muddy village square at night ringed by crooked timber houses, a mossy stone well in the foreground, warm amber light from the inn";

/** Draws a "picture" (the prompt's bytes) at once, or when let go; records what it was asked. */
function fakePainter() {
  const asked: string[] = [];
  const shapes: (string | undefined)[] = [];
  let release = () => {};
  let hold: Promise<void> | undefined;
  const painter: Painter & { asked: string[]; shapes: (string | undefined)[]; holdNext(): () => void } = {
    asked,
    shapes,
    async draw(prompt, _seed, options) {
      asked.push(prompt);
      shapes.push(options?.shape);
      await hold;
      return Buffer.from(prompt);
    },
    holdNext() {
      hold = new Promise((r) => (release = r));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
  return painter;
}

const promptWriter = () => new MockProvider((req) => JSON.stringify({ prompt: `${PROMPT} (${req.messages.at(-1)!.content.split("\n").find((l) => l.startsWith("The place:"))})` }));

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "tui-rpg-art-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

test("the image prompt is the model's description of what's there, in the campaign's art style", async () => {
  const llm = new MockProvider(() => JSON.stringify({ prompt: PROMPT + "." }));
  const prompt = await imagePrompt(llm, world, square);
  assert.equal(prompt, `${PROMPT}. ${world.artStyle}`);
  const asked = llm.requests[0].messages.at(-1)!.content;
  assert.match(asked, /Brackenford Square/);
  assert.match(asked, /mossy-roofed well/);
  assert.match(llm.requests[0].messages[0].content, /No people or creatures/);
});

test("a portrait is drawn from how someone looks, never from their persona, knowledge or name", async () => {
  const llm = new MockProvider(() => JSON.stringify({ prompt: "Head-and-shoulders portrait of a hunched old man with a grey beard, rain-soaked wool coat, tired eyes" }));
  const pell = world.npcs.get("old-pell")!;
  const prompt = await portraitPrompt(llm, world, pell);
  assert.match(prompt, /^Head-and-shoulders portrait of a hunched old man/);
  assert.ok(prompt.endsWith(world.artStyle!));
  const asked = llm.requests[0].messages.map((m) => m.content).join("\n");
  assert.match(asked, /a hunched old man in a sodden wool coat/);
  assert.doesNotMatch(asked, /Old Pell|Pell/, "not their name");
  for (const fact of pell.knowledge) assert.ok(!asked.includes(fact.fact), "not what they know");
  assert.ok(!asked.includes(pell.persona.slice(0, 40)), "not their persona");
});

test("a reply without a usable prompt falls back to the place's own description", async () => {
  const prompt = await imagePrompt(new MockProvider(() => '{"kind": "act"}'), { ...world, artStyle: undefined }, square);
  assert.match(prompt, /^Brackenford Square\. A muddy square ringed by crooked houses/);
  assert.match(prompt, /concept art/);
});

test("a place is drawn once, on first asking; after that its picture is there straight away", () =>
  withDir(async (dir) => {
    const painter = fakePainter();
    const ready: string[] = [];
    const illustrator = new Illustrator({ painter, llm: promptWriter(), dir, onReady: (c, subject, file) => ready.push(`${c}/${subject.id} ${file}`) });
    const file = path.join(dir, "hollow-lantern", "village-square.png");

    assert.equal(illustrator.picture("hollow-lantern", world, place("village-square")), undefined);
    assert.equal(illustrator.picture("hollow-lantern", world, place("village-square")), undefined, "asking again doesn't draw it twice");
    await waitFor(() => ready.length === 1);
    assert.deepEqual(ready, [`hollow-lantern/village-square ${file}`]);
    assert.equal(painter.asked.length, 1);
    assert.match(await readFile(file, "utf8"), /mossy stone well/);
    assert.match(await readFile(file.replace(".png", ".prompt.txt"), "utf8"), /Brackenford Square/);
    assert.ok(!existsSync(`${file}.part`));

    assert.equal(illustrator.picture("hollow-lantern", world, place("village-square")), file);
    assert.equal(painter.asked.length, 1);
  }));

test("while one picture is drawn, the latest place asked for is drawn next", () =>
  withDir(async (dir) => {
    const painter = fakePainter();
    const ready: string[] = [];
    const illustrator = new Illustrator({ painter, llm: promptWriter(), dir, onReady: (_c, subject) => ready.push(subject.id) });
    const release = painter.holdNext();
    illustrator.picture("hollow-lantern", world, place("village-square"));
    await waitFor(() => painter.asked.length === 1);
    for (const id of ["hollow-lantern-inn", "inn-cellar", "forest-edge"]) illustrator.picture("hollow-lantern", world, place(id));
    release();
    await waitFor(() => ready.length === 4);
    assert.deepEqual(ready, ["village-square", "forest-edge", "inn-cellar", "hollow-lantern-inn"]);
  }));

test("places are drawn before portraits, people upright and places wide, each kept in its own folder", () =>
  withDir(async (dir) => {
    const painter = fakePainter();
    const ready: string[] = [];
    const illustrator = new Illustrator({ painter, llm: promptWriter(), dir, onReady: (_c, subject, file) => ready.push(`${subject.kind} ${path.relative(dir, file)}`) });
    const release = painter.holdNext();
    illustrator.picture("hollow-lantern", world, place("village-square"));
    await waitFor(() => painter.asked.length === 1);
    illustrator.picture("hollow-lantern", world, person("old-pell"));
    illustrator.picture("hollow-lantern", world, place("hollow-lantern-inn"));
    illustrator.picture("hollow-lantern", world, person("marta"));
    assert.equal(illustrator.pending("hollow-lantern", person("marta")), true);
    release();
    await waitFor(() => ready.length === 4);
    assert.deepEqual(ready, [
      `place ${path.join("hollow-lantern", "village-square.png")}`,
      `place ${path.join("hollow-lantern", "hollow-lantern-inn.png")}`,
      `person ${path.join("hollow-lantern", "people", "marta.png")}`,
      `person ${path.join("hollow-lantern", "people", "old-pell.png")}`,
    ]);
    assert.deepEqual(painter.shapes, ["landscape", "landscape", "portrait", "portrait"]);
    assert.equal(illustrator.drawn("hollow-lantern", person("marta")), path.join(dir, "hollow-lantern", "people", "marta.png"));
    assert.equal(illustrator.drawn("hollow-lantern", place("forest-edge")), undefined);
    assert.equal(illustrator.picture("hollow-lantern", world, person("nobody")), undefined, "someone the campaign hasn't got isn't drawn");
  }));

test("if drawing fails, it's said once and nothing more is drawn", () =>
  withDir(async (dir) => {
    const errors: string[] = [];
    let draws = 0;
    const painter: Painter = {
      async draw() {
        draws++;
        throw new Error("couldn't reach ComfyUI at http://localhost:1");
      },
    };
    const illustrator = new Illustrator({ painter, llm: promptWriter(), dir, onError: (e) => errors.push(e.message) });
    illustrator.picture("hollow-lantern", world, place("village-square"));
    illustrator.picture("hollow-lantern", world, place("hollow-lantern-inn"));
    await waitFor(() => errors.length === 1);
    illustrator.picture("hollow-lantern", world, place("forest-edge"));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(errors, ["couldn't reach ComfyUI at http://localhost:1"]);
    assert.equal(draws, 1);
  }));

/** A stand-in ComfyUI: takes a workflow, is busy for one poll, then has the picture. */
async function fakeComfy(reply?: { status: number; body: unknown }) {
  const workflows: Record<string, { class_type: string; inputs: Record<string, unknown> }>[] = [];
  let polls = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      for await (const chunk of req) body += chunk;
      workflows.push(JSON.parse(body).prompt);
      res.writeHead(reply?.status ?? 200, { "content-type": "application/json" });
      return res.end(JSON.stringify(reply?.body ?? { prompt_id: "p1", number: 1 }));
    }
    if (url.pathname === "/history/p1") {
      res.writeHead(200, { "content-type": "application/json" });
      if (polls++ === 0) return res.end("{}");
      return res.end(JSON.stringify({ p1: { status: { status_str: "success", completed: true }, outputs: { save: { images: [{ filename: "tui_rpg_00001_.png", subfolder: "", type: "output" }] } } } }));
    }
    if (url.pathname === "/view" && url.searchParams.get("filename") === "tui_rpg_00001_.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, workflows, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("ComfyUI is given the prompt in its workflow, and the picture it saves is fetched", async () => {
  const comfy = await fakeComfy();
  try {
    const png = await new ComfyPainter({ url: comfy.url, pollMs: 5 }).draw("a mossy well", 42);
    assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47]);
    const [workflow] = comfy.workflows;
    assert.equal(workflow.positive.inputs.text, "a mossy well");
    assert.equal(workflow.sample.inputs.seed, 42);
    assert.equal(workflow.unet.inputs.unet_name, "moss_image_sft_int8_convrot.safetensors");
  } finally {
    await comfy.close();
  }
});

test("ComfyUI turning the workflow down, or not being there, says why", async () => {
  const comfy = await fakeComfy({
    status: 400,
    body: {
      error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
      node_errors: { unet: { errors: [{ message: "Value not in list", details: "unet_name: 'moss_image_sft_int8_convrot.safetensors' not in []" }] } },
    },
  });
  try {
    await assert.rejects(new ComfyPainter({ url: comfy.url }).draw("x", 1), /wouldn't take the workflow: Value not in list: unet_name: 'moss_image/);
  } finally {
    await comfy.close();
  }
  await assert.rejects(new ComfyPainter({ url: comfy.url }).draw("x", 1), new RegExp(`couldn't reach ComfyUI at ${comfy.url}`));
});

test("arriving somewhere draws it and who's there, and the frontend hears when each is ready, over the protocol too", () =>
  withDir(async (artDir) => {
    const painter = fakePainter();
    const config = { contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "", artDir } as const;
    const toEngine = new PassThrough();
    const fromEngine = new PassThrough();
    void serve(createGame(config, { pictures: true, painter }), toEngine, fromEngine);
    const game = new RemoteGame(fromEngine, toEngine);
    const events: GameEvent[] = [];
    game.subscribe((e) => events.push(e));

    await game.open("hollow-lantern", "new");
    for (const answer of ["Ash", "they", "3 3 2 2"]) await game.submit(answer);
    const begun = await game.submit("yes");
    assert.equal(begun.view.player?.place.image, undefined, "not drawn yet");
    assert.equal(begun.view.player?.place.drawing, true, "but on its way");
    assert.equal(begun.view.player?.people[0].drawing, true, "and the old man's portrait");
    // The place first, then the portrait.
    await waitFor(() => events.length === 2);
    const views = events.map((e) => (e.kind === "view" ? e.view.player! : undefined));
    const file = path.join(artDir, "hollow-lantern", "village-square.png");
    assert.equal(views[0]?.place.image, file);
    assert.equal(views[0]?.place.drawing, undefined);
    assert.equal(views[0]?.people[0].drawing, true);
    assert.equal(views[0]?.map.cells[0].image, file, "the map shows it too");
    assert.equal(views[1]?.people[0].image, path.join(artDir, "hollow-lantern", "people", "old-pell.png"));
    const looked = (await game.submit("/look")).view.player!;
    assert.equal(looked.place.image, file, "and they stay");
    assert.equal(looked.people[0].image, path.join(artDir, "hollow-lantern", "people", "old-pell.png"));
    // Somewhere else, the map still shows the square's picture.
    const inn = (await game.submit("/go inn")).view.player!;
    assert.equal(inn.map.cells.find((c) => c.id === "village-square")?.image, file);
    // The inn and the innkeeper are drawn next.
    await waitFor(() => existsSync(path.join(artDir, "hollow-lantern", "people", "marta.png")));
    await game.close();
  }));

test("when pictures can't be drawn, the player is told, and the place stops waiting for one", () =>
  withDir(async (artDir) => {
    const painter: Painter = { draw: async () => Promise.reject(new Error("couldn't reach ComfyUI at http://localhost:1")) };
    const config = { contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "", artDir } as const;
    const game = await createGame(config, { pictures: true, painter });
    const events: GameEvent[] = [];
    game.subscribe((e) => events.push(e));
    await game.open("hollow-lantern", "new");
    for (const answer of ["Ash", "they", "3 3 2 2", "yes"]) await game.submit(answer);
    await waitFor(() => events.length === 2);
    assert.deepEqual(events[0], { kind: "notice", text: "Pictures are off: couldn't reach ComfyUI at http://localhost:1" });
    assert.equal(events[1].kind === "view" && events[1].view.player?.place.drawing, undefined);
    assert.equal(events[1].kind === "view" && events[1].view.player?.people[0].drawing, undefined);
    assert.equal((await game.submit("/look")).view.player?.place.drawing, undefined, "and nothing more is drawn");
    await game.close();
  }));

test("a frontend that doesn't show pictures has nothing drawn", async () => {
  const painter = fakePainter();
  const game = await createGame(
    { contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" },
    { painter },
  );
  await game.open("hollow-lantern", "new");
  for (const answer of ["Ash", "they", "3 3 2 2", "yes"]) await game.submit(answer);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(painter.asked.length, 0);
  await game.close();
});

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(condition(), "timed out waiting");
}
