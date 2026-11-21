import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import { Cutouts, harden, type Cutter } from "./cutout.js";

/** "Cuts" a picture by copying it with a mark; or fails, if told to. */
function fakeCutter(fail?: Error): Cutter & { cuts: string[] } {
  const cuts: string[] = [];
  return {
    cuts,
    async cut(input, output) {
      cuts.push(path.basename(input));
      if (fail) throw fail;
      await writeFile(output, `cut:${await readFile(input, "utf8")}`);
    },
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "tui-rpg-cut-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

test("a portrait is cut out once, in the background, and kept beside it", () =>
  withDir(async (dir) => {
    const portrait = path.join(dir, "pell.png");
    await writeFile(portrait, "pell");
    const cutter = fakeCutter();
    const ready = new EventEmitter();
    const cutouts = new Cutouts({ cutter, dir, onReady: (c, id, file) => ready.emit("ready", `${c}/${id}`, file) });

    assert.equal(cutouts.of("hl", "old-pell", portrait), undefined, "not yet: it's being cut");
    assert.equal(cutouts.of("hl", "old-pell", portrait), undefined, "asking again doesn't cut it twice");
    const [who, file] = await once(ready, "ready");
    assert.equal(who, "hl/old-pell");
    assert.equal(file, path.join(dir, "hl", "people", "old-pell.cutout.png"));
    assert.equal(await readFile(file, "utf8"), "cut:pell");
    assert.equal(cutouts.of("hl", "old-pell", portrait), file, "after that, it's there straight away");
    assert.deepEqual(cutter.cuts, ["pell.png"]);
    assert.ok(!existsSync(file.replace(/\.png$/, ".part.png")), "nothing half-written is left");
  }));

test("a portrait drawn again since it was cut out is cut out again", () =>
  withDir(async (dir) => {
    const portrait = path.join(dir, "pell.png");
    await writeFile(portrait, "pell");
    const ready = new EventEmitter();
    const cutouts = new Cutouts({ cutter: fakeCutter(), dir, onReady: () => ready.emit("ready") });
    cutouts.of("hl", "old-pell", portrait);
    await once(ready, "ready");
    // Redrawn a minute later.
    const later = new Date(Date.now() + 60_000);
    await writeFile(portrait, "pell, redrawn");
    await utimes(portrait, later, later);
    assert.equal(cutouts.of("hl", "old-pell", portrait), undefined);
    await once(ready, "ready");
    assert.equal(await readFile(cutouts.file("hl", "old-pell"), "utf8"), "cut:pell, redrawn");
  }));

test("if cutting fails, the player is told once and no more are tried", () =>
  withDir(async (dir) => {
    for (const id of ["a", "b"]) await writeFile(path.join(dir, `${id}.png`), id);
    const cutter = fakeCutter(new Error("no model"));
    const errors: string[] = [];
    const failed = new EventEmitter();
    const cutouts = new Cutouts({ cutter, dir, onError: (err) => (errors.push(err.message), failed.emit("failed")) });
    cutouts.of("hl", "a", path.join(dir, "a.png"));
    cutouts.of("hl", "b", path.join(dir, "b.png"));
    await once(failed, "failed");
    assert.equal(cutouts.of("hl", "b", path.join(dir, "b.png")), undefined);
    assert.deepEqual([errors, cutter.cuts], [["no model"], ["a.png"]]);
  }));

test("a cut-out's mask is made decisive: background fully transparent, the subject fully opaque, only the edge between", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "cut.png");
    // Five pixels: background, faint haze, an edge, a nearly solid subject, a solid one.
    const alphas = [0, 20, 128, 230, 255];
    const pixels = Buffer.from(alphas.flatMap((a) => [200, 100, 50, a]));
    await sharp(pixels, { raw: { width: 5, height: 1, channels: 4 } }).png().toFile(file);
    await harden(file);
    const { data } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const after = [...data].filter((_, i) => i % 4 === 3);
    assert.deepEqual([after[0], after[1], after[3], after[4]], [0, 0, 255, 255]);
    assert.ok(after[2] > 0 && after[2] < 255, "the edge stays blended");
    assert.deepEqual([...data.subarray(4, 8)], [0, 0, 0, 0], "nothing of the background is kept in what's transparent");
  }));
