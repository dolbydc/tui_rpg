import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import { loadWorld } from "../world/loader.js";
import { LINE_PAUSE, sentences, trimSilence } from "./kokoro.js";
import type { Speaker, Utterance } from "./speaker.js";
import { VoiceOver, voiceScript } from "./voice-over.js";

const world = await loadWorld(DEFAULT_CAMPAIGN_DIR);

test("narration in the narrator's voice; an NPC's speech in theirs, with their actions narrated", () => {
  const script = voiceScript(
    [
      { kind: "player", text: "Evening." },
      { kind: "narration", text: "Rain drums on the shutters." },
      { kind: "npc", npcId: "marta", speaker: "The innkeeper", text: '"Evening." *She sets down a cup.* "What brings you here?"' },
      { kind: "system", text: "— Turn 2 —" },
    ],
    world,
  );
  assert.deepEqual(script, [
    { text: "Rain drums on the shutters.", voice: "bm_george" },
    { text: "Evening.", voice: "bf_emma" },
    { text: "She sets down a cup.", voice: "bm_george" },
    { text: "What brings you here?", voice: "bf_emma" },
  ]);
});

test("a scene's heading, the place's name, is shown but not read out", () => {
  const scene = "Brackenford Square\nA muddy square ringed by crooked houses.\nExits: inn (The Hollow Lantern)";
  assert.deepEqual(voiceScript([{ kind: "narration", text: scene }, { kind: "narration", text: "**The Hollow Lantern**" }], world), [
    { text: "A muddy square ringed by crooked houses.\nExits: inn (The Hollow Lantern)", voice: "bm_george" },
  ]);
});

test("an NPC without a voice gets one to match their pronouns", () => {
  const npcs = new Map([["x", { ...world.npcs.get("marta")!, id: "x", voice: undefined, pronouns: "he/him" }]]);
  assert.deepEqual(voiceScript([{ kind: "npc", npcId: "x", text: "Hm." }], { npcs }), [{ text: "Hm.", voice: "bm_daniel" }]);
});

test("long text is read a sentence at a time", () => {
  assert.deepEqual(
    sentences({ text: 'You push the door. "Anyone here?" Silence… then a cough', voice: "v" }).map((u) => u.text),
    ["You push the door.", '"Anyone here?"', "Silence…", "then a cough."],
  );
});

test("each line of a scene ends with a full stop and a pause, so headings and lists don't run on", () => {
  const scene = [
    "Brackenford Square",
    "A muddy square ringed by crooked houses. East, the road narrows.",
    "Exits: inn (The Hollow Lantern), east (Edge of the Thornwood)",
    "People here: a hunched old man in a sodden wool coat",
    "You see: torn notice",
  ].join("\n");
  assert.deepEqual(
    sentences({ text: scene, voice: "v" }).map((u) => [u.text, u.pause]),
    [
      ["Brackenford Square.", LINE_PAUSE],
      ["A muddy square ringed by crooked houses.", undefined],
      ["East, the road narrows.", LINE_PAUSE],
      ["Exits: inn (The Hollow Lantern), east (Edge of the Thornwood).", LINE_PAUSE],
      ["People here: a hunched old man in a sodden wool coat.", LINE_PAUSE],
      ["You see: torn notice.", LINE_PAUSE],
    ],
  );
});

test("nothing is said while reading aloud is off, and turning it off stops what's being said", () => {
  const said: Utterance[][] = [];
  let stopped = 0;
  const speaker: Speaker = { speak: (u) => said.push(u), stop: () => stopped++, close: async () => {} };
  const voice = new VoiceOver(speaker, world, false);
  voice.say([{ kind: "narration", text: "Quiet." }]);
  assert.equal(said.length, 0);
  voice.setEnabled(true);
  voice.say([{ kind: "narration", text: "Loud." }]);
  assert.equal(said.length, 1);
  voice.setEnabled(false);
  assert.equal(stopped, 1);
});

test("only three quarters of the silence around a sentence is kept", () => {
  const speech = new Float32Array([0, 0, 0, 0, 0.5, -0.5, 0, 0, 0, 0, 0, 0, 0, 0]);
  const trimmed = trimSilence(speech, 0.75);
  assert.deepEqual(Array.from(trimmed), [0, 0, 0, 0.5, -0.5, 0, 0, 0, 0, 0, 0]);
  assert.equal(trimSilence(new Float32Array(4), 0.75).length, 4);
});
