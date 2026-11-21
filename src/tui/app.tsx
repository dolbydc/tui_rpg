import { useEffect, useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import type { Game, GameView, LogLine, Opened } from "../engine/api.js";
import type { MusicPlayer } from "../voice/music.js";
import type { VoiceOver } from "../voice/voice-over.js";
import { EMPTY_LINE, editLine, type LineState } from "./line-editor.js";
import { CharacterSheet, DialogueLog, InputLine, Inventory, MapPanel, QuestLog, type ScrollRange } from "./panels.js";

/** Wide enough for a map three places across. */
const SIDEBAR_WIDTH = 36;

interface AppProps {
  game: Game;
  /** The campaign just opened: the lines to start with, and the game as it stands. */
  opened: Opened;
  voice: VoiceOver;
  /** Plays the mood music of wherever the player is. */
  music: MusicPlayer;
  /** Back to the start menu (/new). */
  onMenu: () => void;
  /** Draw the sidebar (map, character, inventory, quests); off where the frontend draws its own. */
  sidebar?: boolean;
}

/** A game in progress, or a character being made for one (before there's a game, without the sidebar). */
export function App({ game, opened, voice, music, onMenu, sidebar = true }: AppProps) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [log, setLog] = useState<LogLine[]>(opened.lines);
  const [input, setInput] = useState<LineState>(EMPTY_LINE);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<GameView>(opened.view);
  // How many rows the story is scrolled back from the newest; 0 follows it as it comes.
  const [back, setBack] = useState(0);
  const range = useRef<ScrollRange>({ max: 0, page: 1 });
  const scroll = (rows: number) => setBack((back) => Math.max(0, Math.min(back + rows, range.current.max)));
  function onScrollRange(next: ScrollRange) {
    // Scrolled back, the story stays where it is as more comes in below.
    const grew = next.max - range.current.max;
    range.current = next;
    setBack((back) => (back > 0 ? Math.max(0, Math.min(back + Math.max(grew, 0), next.max)) : 0));
  }
  // Each row of places on the map takes six lines; show more of it on taller terminals.
  const mapRows = rows >= 46 ? 3 : rows >= 38 ? 2 : 1;

  useEffect(() => {
    voice.onNotice = (text) => setLog((log) => [...log, { kind: "system", text }]);
    // A new game's opening is read aloud; a resumed one's history isn't.
    if (!opened.resumed) voice.say(opened.lines);
    music.play(opened.view.music);
    // Between turns, the game can change by itself (a picture drawn) or have something to say.
    return game.subscribe((event) => {
      if (event.kind === "view") setView(event.view);
      else if (event.kind === "notice") setLog((log) => [...log, { kind: "system", text: event.text }]);
    });
  }, []);

  async function submit(text: string) {
    setBack(0);
    setLog((lines) => [...lines, { kind: "player", text }]);
    setBusy(true);
    voice.stop();
    let result;
    try {
      result = await game.submit(text);
    } catch (err) {
      // The engine itself has failed (a turn that goes wrong comes back as an error line).
      setLog((log) => [...log, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
      setBusy(false);
      return;
    }
    if (result.quit) {
      exit();
      return;
    }
    if (result.menu) {
      onMenu();
      return;
    }
    const lines: LogLine[] = result.voice
      ? [{ kind: "system", text: `Reading aloud is ${voice.setEnabled(result.voice.on ?? !voice.enabled) ? "on" : "off"}.` }]
      : result.music
        ? [{ kind: "system", text: `Music is ${music.setEnabled(result.music.on ?? !music.enabled) ? "on" : "off"}.` }]
        : result.lines;
    music.play(result.view.music);
    voice.say(lines);
    setLog((log) => (result.reset ? lines : [...log, ...lines]).slice(-200));
    setView(result.view);
    setBusy(false);
  }

  useInput((char, key) => {
    if (key.escape) {
      exit();
      return;
    }
    if (key.tab) {
      voice.stop();
      return;
    }
    // Scrolling the story works while a turn is under way, too.
    if (key.upArrow || key.downArrow) {
      scroll(key.upArrow ? 1 : -1);
      return;
    }
    if (key.pageUp || key.pageDown) {
      scroll(key.pageUp ? range.current.page : -range.current.page);
      return;
    }
    if (busy) return;
    // Keys typed while the app was busy can arrive in one chunk; an Enter at the end of it still submits.
    const enter = key.return || (/[\r\n]$/.test(char) && !key.ctrl && !key.meta);
    if (enter) {
      const text = (key.return ? input : editLine(input, char.replace(/[\r\n]+$/, ""), key)).text.trim();
      setInput(EMPTY_LINE);
      if (text) void submit(text);
      return;
    }
    setInput((line) => editLine(line, char, key));
  });

  const { player } = view;
  return (
    <Box flexDirection="column" height={Math.max(rows - 1, sidebar ? 16 : 6)}>
      {/* Exactly the height the input line leaves: sized from its content, a long story pushed the input line
          out of the frame in a short terminal. The story inside is cut at the top instead. */}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} overflow="hidden">
        <DialogueLog title={`${view.title} · ${player ? player.place.name : "A new character"}`} lines={log} busy={busy} back={back} onScrollRange={onScrollRange} />
        {player && sidebar && (
          <Box flexDirection="column" width={SIDEBAR_WIDTH} flexShrink={0}>
            <MapPanel map={player.map} width={SIDEBAR_WIDTH} rows={mapRows} />
            <CharacterSheet character={player.character} status={player.status} />
            <Inventory items={player.character.inventory} />
            <QuestLog quests={player.quests} />
          </Box>
        )}
      </Box>
      <InputLine line={input} busy={busy} />
    </Box>
  );
}
