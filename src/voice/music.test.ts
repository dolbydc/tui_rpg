import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import { NarrativeEngine } from "../narrative/engine.js";
import { MockProvider } from "../llm/mock.js";
import { InMemoryStore } from "../storage/memory.js";
import { SessionController } from "../game/session.js";
import { WorldEngine } from "../world/engine.js";
import { loadWorld } from "../world/loader.js";
import { MusicPlayer, musicCommands, type MusicCommand } from "./music.js";

/** The Hollow Lantern with music: the world's everywhere, the inn's own, and silence in the cellar. */
async function withMusic(edit: (dir: string) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "tui-rpg-music-"));
  await cp(DEFAULT_CAMPAIGN_DIR, dir, { recursive: true });
  await writeFile(path.join(dir, "village.ogg"), "");
  await writeFile(path.join(dir, "inn.ogg"), "");
  const frontmatter = async (file: string, line: string) => {
    const text = await readFile(path.join(dir, file), "utf8");
    await writeFile(path.join(dir, file), text.replace(/^---\n/, `---\n${line}\n`));
  };
  await frontmatter("world.md", "music: village.ogg");
  await frontmatter("locations/hollow-lantern-inn.md", "music: inn.ogg");
  await frontmatter("locations/inn-cellar.md", "music: none");
  await edit(dir);
  return dir;
}

test("a location plays its own music, or none, and everywhere else plays the world's", async () => {
  const dir = await withMusic();
  try {
    const world = await loadWorld(dir);
    assert.equal(world.music, path.join(dir, "village.ogg"));
    const session = new SessionController({
      world: new WorldEngine(world),
      narrative: new NarrativeEngine(new MockProvider(), world.rules),
      store: new InMemoryStore(),
      campaignId: "test",
    });
    // Making the first character, before there's a game: the world's.
    session.newCharacter();
    assert.equal(session.music, path.join(dir, "village.ogg"));
    await session.start();
    assert.equal(session.music, path.join(dir, "village.ogg"));
    await session.submit("/go inn");
    assert.equal(session.music, path.join(dir, "inn.ogg"));
    await session.submit("/go down");
    assert.equal(session.scene.location.id, "inn-cellar");
    assert.equal(session.music, undefined);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("music that isn't there stops the campaign loading, saying which", async () => {
  const dir = await withMusic((dir) => rm(path.join(dir, "inn.ogg")));
  try {
    await assert.rejects(loadWorld(dir), /hollow-lantern-inn\.md: music file "inn\.ogg" isn't there/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

/** A pretend player process, ended by the test. */
class FakeChild extends EventEmitter {
  killed = false;
  kill() {
    this.killed = true;
    this.emit("close", null);
    return true;
  }
}

function fakePlayer() {
  const started: { command: MusicCommand; child: FakeChild }[] = [];
  const errors: string[] = [];
  const music = new MusicPlayer({
    platform: "linux",
    onError: (err) => errors.push(err.message),
    start: (command) => {
      const child = new FakeChild();
      started.push({ command, child });
      return child as unknown as ChildProcess;
    },
  });
  return { music, started, errors };
}

test("music loops, carries on through a turn in the same place, and changes with the place", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { music, started } = fakePlayer();
  music.play("/a.ogg");
  music.play("/a.ogg");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].command.args.at(-1), "/a.ogg");

  t.mock.timers.tick(60_000);
  started[0].child.emit("close", 0);
  assert.equal(started.length, 2, "started again at the end of the track");

  music.play("/b.ogg");
  assert.ok(started[1].child.killed);
  assert.equal(started[2].command.args.at(-1), "/b.ogg");

  music.play(undefined);
  assert.ok(started[2].child.killed);
  assert.equal(started.length, 3);
});

test("a track that ends as soon as it starts is tried again, but not forever", () => {
  const { music, started, errors } = fakePlayer();
  music.play("/a.ogg");
  for (let i = 0; i < 3; i++) started[i].child.emit("close", 0);
  assert.equal(started.length, 3);
  assert.deepEqual(errors, ["/a.ogg ended as soon as it started, 3 times"]);
});

test("music off is silent until it's back on; a player that isn't installed gives way to the next", () => {
  const { music, started, errors } = fakePlayer();
  music.setEnabled(false);
  music.play("/a.ogg");
  assert.equal(started.length, 0);
  music.setEnabled(true);
  assert.equal(started.length, 1);

  started[0].child.emit("error", Object.assign(new Error("spawn paplay ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(
    started.map((s) => s.command.name),
    ["paplay", "pw-play"],
  );
  started[1].child.emit("close", 1);
  assert.deepEqual(errors, ["pw-play couldn't play /a.ogg (exit code 1)"]);
  music.play("/b.ogg");
  assert.equal(started.length, 2, "and it stays quiet after failing");
});

test("each system's music player, at the volume asked for", () => {
  assert.deepEqual(musicCommands("/m.mp3", 0.5, "darwin")[0].args, ["-v", "0.5", "/m.mp3"]);
  assert.equal(musicCommands("C:\\it's.mp3", 0.5, "win32")[0].args.at(-1)?.includes("'C:\\it''s.mp3'"), true);
  assert.equal(musicCommands("/m.wav", 0.5, "linux")[0].args[0], "--volume=32768");
  assert.deepEqual(musicCommands("/m.wav", 0.5, "linux", "aplay").map((c) => c.name), ["aplay"]);
});
