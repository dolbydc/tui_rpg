import assert from "node:assert/strict";
import { test } from "node:test";
import type { Key } from "ink";
import { EMPTY_LINE, editLine, type LineState } from "./line-editor.js";

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

type Press = string | Partial<Key> | [string, Partial<Key>];

/** Applies keypresses in order: a string is typed text, an object is a special key. */
function press(line: LineState, ...presses: Press[]): LineState {
  return presses.reduce((state, p) => {
    if (typeof p === "string") return editLine(state, p, NO_KEY);
    if (Array.isArray(p)) return editLine(state, p[0], { ...NO_KEY, ...p[1] });
    return editLine(state, "", { ...NO_KEY, ...p });
  }, line);
}

test("typing appends at the cursor", () => {
  assert.deepEqual(press(EMPTY_LINE, "h", "i"), { text: "hi", cursor: 2 });
});

test("arrows move the cursor, and typing inserts there", () => {
  const line = press(EMPTY_LINE, "go est", { leftArrow: true }, { leftArrow: true }, "a");
  assert.deepEqual(line, { text: "go east", cursor: 5 });
  assert.deepEqual(press(line, { rightArrow: true }, { rightArrow: true }, { rightArrow: true }), { text: "go east", cursor: 7 });
});

test("the cursor stays within the line", () => {
  assert.equal(press(EMPTY_LINE, "ab", { rightArrow: true }).cursor, 2);
  assert.equal(press(EMPTY_LINE, "ab", { leftArrow: true }, { leftArrow: true }, { leftArrow: true }).cursor, 0);
});

test("Home and End (and Ctrl+A / Ctrl+E) jump to the ends", () => {
  const line = press(EMPTY_LINE, "look around");
  assert.equal(press(line, { home: true }).cursor, 0);
  assert.equal(press(line, ["a", { ctrl: true }]).cursor, 0);
  assert.equal(press(line, { home: true }, { end: true }).cursor, 11);
  assert.equal(press(line, { home: true }, ["e", { ctrl: true }]).cursor, 11);
  assert.deepEqual(press(line, { home: true }, "/"), { text: "/look around", cursor: 1 });
});

test("Backspace deletes before the cursor; Delete deletes at it", () => {
  const line = press(EMPTY_LINE, "abcd", { leftArrow: true }, { leftArrow: true }); // ab|cd
  assert.deepEqual(press(line, { backspace: true }), { text: "acd", cursor: 1 });
  assert.deepEqual(press(line, { delete: true }), { text: "abd", cursor: 2 });
  assert.deepEqual(press(line, { home: true }, { backspace: true }), { text: "abcd", cursor: 0 });
  assert.deepEqual(press(line, { end: true }, { delete: true }), { text: "abcd", cursor: 4 });
});

test("pasted text goes in at the cursor on one line; control keys type nothing", () => {
  const line = press(EMPTY_LINE, "say  please", { home: true }, { rightArrow: true }, { rightArrow: true }, { rightArrow: true }, { rightArrow: true });
  assert.deepEqual(press(line, "hello\r\nthere"), { text: "say hello there please", cursor: 15 });
  assert.deepEqual(press(line, ["x", { ctrl: true }], { upArrow: true }, ["", { return: true }]), line);
});
