import assert from "node:assert/strict";
import { test } from "node:test";
import { FallbackPlayer, systemPlayer, wav, type AudioPlayer } from "./players.js";

test("each system gets its own player, unless one is chosen", () => {
  assert.equal(systemPlayer("darwin").name, "afplay");
  assert.equal(systemPlayer("win32").name, "powershell");
  assert.equal(systemPlayer("linux").name, "paplay");
  assert.equal(systemPlayer("linux", "aplay").name, "aplay");
});

test("audio for SoundPlayer and afplay is a 16-bit mono PCM WAV", () => {
  const out = wav(new Float32Array([0, 1, -1, 2]), 24000);
  assert.equal(out.toString("ascii", 0, 4), "RIFF");
  assert.equal(out.toString("ascii", 8, 12), "WAVE");
  assert.equal(out.readUInt16LE(20), 1); // PCM
  assert.equal(out.readUInt16LE(22), 1); // mono
  assert.equal(out.readUInt32LE(24), 24000);
  assert.equal(out.readUInt16LE(34), 16);
  assert.equal(out.readUInt32LE(40), 8);
  // Clipped to the 16-bit range.
  assert.deepEqual([0, 1, 2, 3].map((i) => out.readInt16LE(44 + i * 2)), [0, 32767, -32767, 32767]);
});

test("on Linux, a player that isn't installed gives way to the next, which is kept from then on", async () => {
  const played: string[] = [];
  const fake = (name: string, installed: boolean): AudioPlayer => ({
    name,
    play: () => {
      played.push(name);
      const done = installed
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error(`${name} isn't installed`), { code: "ENOENT" }));
      return { done, stop: () => {} };
    },
    close: () => {},
  });
  const player = new FallbackPlayer([fake("paplay", false), fake("pw-play", false), fake("aplay", true)]);
  await player.play(new Float32Array(1), 24000).done;
  await player.play(new Float32Array(1), 24000).done;
  assert.deepEqual(played, ["paplay", "pw-play", "aplay", "aplay"]);
  assert.equal(player.name, "aplay");

  const none = new FallbackPlayer([fake("paplay", false)]);
  await assert.rejects(none.play(new Float32Array(1), 24000).done, /paplay isn't installed/);
});
