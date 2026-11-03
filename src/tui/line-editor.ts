import type { Key } from "ink";

/** The input line: its text and where the cursor sits (0 = before the first character). */
export interface LineState {
  text: string;
  cursor: number;
}

export const EMPTY_LINE: LineState = { text: "", cursor: 0 };

/**
 * Applies one keypress to the input line: ←/→ move, Home/End (or Ctrl+A/Ctrl+E) jump to the ends,
 * Backspace deletes before the cursor, Delete at it, and typed or pasted text goes in at the cursor.
 * Keys it doesn't handle (Enter, Esc, ↑/↓…) leave the line unchanged.
 */
export function editLine({ text, cursor }: LineState, input: string, key: Key): LineState {
  if (key.leftArrow) return { text, cursor: Math.max(cursor - 1, 0) };
  if (key.rightArrow) return { text, cursor: Math.min(cursor + 1, text.length) };
  if (key.home || (key.ctrl && input === "a")) return { text, cursor: 0 };
  if (key.end || (key.ctrl && input === "e")) return { text, cursor: text.length };
  if (key.backspace) {
    return cursor === 0 ? { text, cursor } : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
  }
  if (key.delete) return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
  if (!input || key.ctrl || key.meta || key.return || key.escape || key.tab) return { text, cursor };
  // Pasted text can carry line breaks; the input is a single line.
  const typed = input.replace(/[\r\n]+/g, " ");
  return { text: text.slice(0, cursor) + typed + text.slice(cursor), cursor: cursor + typed.length };
}
