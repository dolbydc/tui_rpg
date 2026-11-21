import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR, DEFAULT_CONTENT_DIR } from "../config.js";
import { loadWorld } from "../world/loader.js";
import type { Game } from "./api.js";
import { createGame } from "./create.js";
import { RemoteGame, serve } from "./protocol.js";

const engine = (contentDir = DEFAULT_CONTENT_DIR) =>
  createGame({ contentDir, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" });

/** Makes the first character, with the answers creation asks for, and begins the game. */
async function play(game: Game, campaignId = "hollow-lantern") {
  const opened = await game.open(campaignId, "continue");
  assert.equal(opened.resumed, false, "nothing saved yet: a new character");
  assert.equal(opened.view.player, undefined, "no game until the character is made");
  for (const answer of ["Ash", "they", "3 3 2 2"]) await game.submit(answer);
  return game.submit("yes");
}

test("the library lists every campaign; a game's view shows what the player knows, and nothing they don't", async () => {
  const game = await engine();
  const { campaigns, saves } = await game.library();
  assert.deepEqual(
    campaigns.map((c) => c.id),
    ["hollow-lantern", "those-dark-places"],
  );
  assert.deepEqual(saves, []);

  const begun = await play(game);
  const { player } = begun.view;
  assert.ok(player);
  assert.equal(player.place.id, "village-square");
  assert.equal(player.character.name, "Ash");
  assert.equal(player.status.actionsLeft, 3);
  const pell = player.people.find((p) => p.id === "old-pell");
  assert.deepEqual(pell, { id: "old-pell", label: "the old man", appearance: "a hunched old man in a sodden wool coat", known: false });
  // No names, personas, knowledge or hidden quests leak to the frontend.
  const json = JSON.stringify(begun.view);
  assert.doesNotMatch(json, /Old Pell|small figure|persona/);
  assert.ok(player.quests.every((q) => q.status !== "pending"));

  assert.equal((await game.library()).saves[0].characterName, "Ash");
  await game.close();
});

test("the cast gives every NPC's voice, so a frontend can read aloud without the world's definitions", async () => {
  const game = await engine();
  const { cast } = await game.open("hollow-lantern", "new");
  assert.equal(cast.npcs["old-pell"].voice, "bm_lewis");
  assert.ok(cast.places.includes("Brackenford Square"));
  await game.close();
});

test("a game served over a pair of streams plays the same as one in this process", async () => {
  const toEngine = new PassThrough();
  const fromEngine = new PassThrough();
  const served = serve(engine(), toEngine, fromEngine);
  const remote = new RemoteGame(fromEngine, toEngine);

  assert.equal((await remote.library()).campaigns.length, 2);
  await assert.rejects(remote.open("nowhere", "new"), /No campaign "nowhere"/);
  const begun = await play(remote);
  assert.equal(begun.reset, true);
  const looked = await remote.submit("/look");
  assert.match(looked.lines[0].text, /Brackenford Square/);
  assert.equal(looked.view.player?.status.actionsLeft, 3, "looking is free");

  await remote.close();
  await served;
  await assert.rejects(remote.submit("/look"), /stopped/);
});

test("a campaign that won't load fails every call with the reason", async () => {
  const toEngine = new PassThrough();
  const fromEngine = new PassThrough();
  void serve(engine(path.join(tmpdir(), "no-such-content-dir")), toEngine, fromEngine);
  const remote = new RemoteGame(fromEngine, toEngine);
  await assert.rejects(remote.library(), /ENOENT|no such file/);
  toEngine.end();
});

test("pictures of places and people are found from the campaign folder, and shown where the player is", async () => {
  const content = await mkdtemp(path.join(tmpdir(), "tui-rpg-art-"));
  const dir = path.join(content, "hollow-lantern");
  try {
    await cp(DEFAULT_CAMPAIGN_DIR, dir, { recursive: true });
    const frontmatter = async (file: string, line: string) => {
      const text = await readFile(path.join(dir, file), "utf8");
      await writeFile(path.join(dir, file), text.replace(/^---\n/, `---\n${line}\n`));
    };
    await writeFile(path.join(dir, "square.png"), "");
    await frontmatter("locations/village-square.md", "image: square.png");
    await frontmatter("npcs/old-pell.md", "image: pell.png");
    await assert.rejects(loadWorld(dir), /old-pell\.md: image file "pell\.png" isn't there/);

    await writeFile(path.join(dir, "pell.png"), "");
    const game = await engine(content);
    const { player } = (await play(game)).view;
    assert.equal(player?.place.image, path.join(dir, "square.png"));
    assert.equal(player?.people.find((p) => p.id === "old-pell")?.image, path.join(dir, "pell.png"));
    await game.close();
  } finally {
    await rm(content, { recursive: true });
  }
});

test("a frontend that asks for the minds gets them in each view, and hears them at work as events", async () => {
  const game = await createGame(
    { contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" },
    { minds: true },
  );
  const heard: string[] = [];
  game.subscribe((event) => {
    if (event.kind === "activity" && event.activity.type === "thinking") heard.push(`${event.activity.agent} ${event.activity.phase}`);
  });
  const begun = await play(game);
  assert.deepEqual(begun.view.minds?.agents.map((a) => a.id).sort(), ["marta", "old-pell"]);
  await game.submit("look about for a while");
  assert.deepEqual(heard.slice(0, 4), ["player start", "player end", "narrator start", "narrator end"]);
  await game.close();
});
