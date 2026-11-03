# TUI RPG

A local-first text RPG in the terminal: a deterministic world engine owns the rules and state,
and a local LLM (Ollama) interprets free-text input and narrates what happens.

## Running

Needs Node 20+ and [Ollama](https://ollama.com) with the model pulled (`ollama pull gemma4:12b`).
Games are saved to a SQLite file, `data/tui_rpg.db`, created on first run.

`gemma4:12b` (~8 GB) fits entirely on a 12 GB GPU, at about 2 s a turn. `gemma4:26b` is a little
stronger but spills onto the CPU on such a card (7–14 s a turn). Smaller models such as `qwen3:8b`
are faster still but give away NPCs' secrets far more often; set `OLLAMA_MODEL` to try another.

```sh
npm install
npm run dev       # run from source
```

Or `npm run build && npm start`. `npm test` runs the tests (no Ollama needed),
`npm run typecheck` checks types.

In game, type anything to act, or use `/look`, `/search [where]`, `/go <exit>`, `/take <item>`,
`/drop <item>`, `/give <item> to <name>`, `/talk <name> <message>`, `/wait`, `/new`, `/help`, `/quit` (Esc also quits).
Progress autosaves after every action and resumes on the next launch. `/memories <name>` shows what an
NPC remembers (a debug aid).

Each turn the player has **3 actions**. Moving, talking, taking, giving and anything else
(attacking, searching…) cost one; looking around is free; `/wait` (or "I wait") spends what's
left. When the actions run out the turn ends: NPCs move on along their routines and may talk among
themselves. The sidebar shows the turn and the actions left (`●●○`).

**Rolls.** Risky attempts are settled by rolling 2d6, keeping the best die, and adding a stat bonus. The interpreter flags an action as
risky (lying, persuading against someone's interests, intimidating, attacking, sneaking, picking a
pocket, climbing, forcing a lock, keeping your nerve) and picks the stat: might (force, fighting),
wits (noticing, knowing, nerve), grace (agility, stealth, aim) or charisma (deceiving, persuading,
intimidating). A place can also demand a roll on first arrival (`arrival_check`, below).

| Stat | 1 | 2 | 3–4 | 5–6 | 7+ |
|---|---|---|---|---|---|
| Bonus | −1 | 0 | +1 | +2 | +3 |

| Best die + bonus | 2 or less | 3–4 | 5–6 | 7+ |
|---|---|---|---|---|
| Outcome | failure (and worse off) | partial failure (no harm, maybe a clue) | partial success | success |

**Drive.** The player has 2 drive, restored to 2 whenever a new quest starts. Pushing an attempt
(`/push <what you do>`, or saying you give it everything) spends one to roll 3d6 instead, still
keeping the best die. Pushing something that needs no roll spends nothing.

Odds (failure / partial failure / partial success / success):

| Stat | 2d6 | 3d6 (pushed) |
|---|---|---|
| 1 | 25 / 44 / 31 / 0 % | 13 / 45 / 42 / 0 % |
| 2 | 11 / 33 / 56 / 0 % | 4 / 26 / 70 / 0 % |
| 3–4 | 3 / 22 / 44 / 31 % | 0 / 12 / 45 / 42 % |
| 5–6 | 0 / 11 / 33 / 56 % | 0 / 4 / 26 / 70 % |
| 7+ | 0 / 3 / 22 / 75 % | 0 / 0 / 12 / 88 % |

The world engine rolls; the narrator (or the NPC on the receiving end) is told only the outcome and
never mentions dice, and the player never sees the roll (it's kept in the turn record). A **partial
success** looks exactly like a success, but leaves a hidden complication that surfaces 2–5 turns
later: an NPC who was lied to, pushed or tricked works out what really happened and remembers it
(and may gossip about it); anything else goes wrong in front of the player next time they're at
that place, and the place stays changed ("Changed: …" in its description). Rules are in
`src/world/checks.ts`.

**New characters.** `/new` asks for a name, pronouns, and a share of 10 points among the stats
(each 1–6), then replaces the current campaign with a fresh one (`/cancel` backs out first).
The campaign's own character (`world.md`) is used for a first launch.

Completing a quest (its `done` conditions, below) pays its **reward**: items and experience.
Experience is spent with `/levelup <stat>`: reaching level n+1 costs 100 × n XP and raises that stat
by 1 and max HP by 2 (it costs no action). The sidebar shows level and XP, and flags when a level
is affordable.

**Time.** The campaign starts at `start_time` (`world.md`; Brackenford begins at 20:00). A turn
takes 10 minutes, or 6 seconds when it's spent in a conversation or confronting someone (any roll
aimed at a person: attacking, intimidating, deceiving). NPC routines move on with the clock (a step
every 10 minutes), not the turn count, so a long conversation doesn't send everyone wandering.
`/sleep` (or "I sleep") ends the turn, passes the time until 07:00, and restores HP. The narrator
and NPCs are always told the day, the part of the day and the time; the sidebar shows it.
Complications from partial successes come due 20–50 in-game minutes later.

**Reading aloud.** Narration and dialogue are spoken with [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
(`kokoro-js`), a local text-to-speech model run on the CPU in a worker thread, played through
PulseAudio's `paplay` (WSLg routes it to Windows). The model (~330 MB, fp32) downloads on first use.
The narrator has one voice (`narrator_voice` in `world.md`); each NPC speaks in theirs (`voice` in
their file, else one picked from their pronouns), and their `*actions*` are read by the narrator.
Your own input and system notes aren't read. Speech starts about 1.5 s after a reply appears; Tab
skips it, a new action cuts it off, and `/voice` toggles it. Voices: `af_heart`, `af_bella`,
`af_nicole`, `af_river`, `af_sarah`, `am_adam`, `am_michael`, `am_fenrir`, … (American) and
`bf_emma`, `bf_isabella`, `bf_alice`, `bf_lily`, `bm_george`, `bm_lewis`, `bm_daniel`, `bm_fable`
(British).

**Travel.** Going to a place you've already been (`/go cellar`, "head back to the Thornwood")
walks the shortest path through places you've visited, one action per step, carrying on into the
next turn if it needs to; exits you haven't taken stay unknown. NPCs along the way notice you pass,
as they would step by step.

**Sneaking.** Trying not to be seen ("I creep past the old man into the inn") is a grace roll marked
as stealth. A success or partial success goes unwitnessed: nobody notices you come, go or do
anything that action (a partial success's catch comes later, as usual). A partial failure is noticed
as normal, but not as sneaking. A failure is noticed, and everyone who sees it remembers catching
you sneaking, which colours how they treat you and can spread as gossip.

The **map** in the sidebar shows only the places the player has visited (fog of war), centred on
the player. Each place is a small box with its label, who's there (`@` you; a known person's
initial, or `?` for someone you haven't been introduced to; shown only where you are) and a `•`
per item lying about. Exits join neighbouring boxes; an exit somewhere you haven't been yet is a
stub leading off the box. The map shows one level at a time, the one you're on: going down into
the inn's cellar replaces the street with just the cellar ("Map · 1 below ground"). A `▲` or `▼` on
a box's border marks stairs up or down.

| Variable | Default | |
|---|---|---|
| `TUI_RPG_LLM` | `ollama` | `mock` runs without a model |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `gemma4:12b` | |
| `TUI_RPG_STORAGE` | `sqlite` | `memory` saves nothing |
| `TUI_RPG_DB` | `data/tui_rpg.db` | the SQLite file |
| `TUI_RPG_CAMPAIGN_DIR` | `content/hollow-lantern` | campaign content to load |
| `TUI_RPG_CAMPAIGN_ID` | `default` | save slot |
| `TUI_RPG_VOICE` | `on` | `off` starts with reading aloud off (`/voice on` turns it on) |

## Architecture

```
tui/          Terminal UI: dialogue log, map, character sheet and turn, inventory, quest log, input
  │
game/         Session controller: commands, the turn pipeline, save/load
  │
  ├── world/      World engine: loads campaign markdown; resolves intents and applies events;
  │               what NPCs perceive and what they're allowed to share (no LLM)
  ├── narrative/  Narrative engine: free text → intent, outcomes → prose and NPC dialogue
  │     │
  │   llm/        LlmProvider interface: Ollama, plus a mock for tests
  └── storage/    CampaignStore interface: SQLite, plus in-memory
voice/        Speaker interface: Kokoro text-to-speech; turns log lines into who says what

domain/       Shared types; depends on nothing
index.tsx     Composition root: the only place that picks implementations
```

Each player action runs the same explicit pipeline in `SessionController`:

1. **Interpret**: slash commands map straight to an intent; free text goes to the narrative engine.
2. **Resolve**: the world engine checks the intent against the rules and returns world events, or a reason it's impossible.
3. **Apply**: the events produce the next `GameState` and the action's cost is spent; spending the last
   action ends the turn. Only world events change state.
4. **Narrate**: the narrative engine describes the authoritative outcome (plain commands get deterministic text).
5. **Observe**: NPCs who were present remember what they noticed, depending on their perception.
6. **NPC exchange**: as a new turn starts, two NPCs who meet may pass on what they know (at most one
   conversation a turn).
7. **Persist**: the new state, the action's record and new NPC memories are saved in one transaction.

The world engine is pure and deterministic, so it's tested directly. The narrative engine is tested
through `MockProvider`, which scripts model replies and records prompts.

### Campaign content

A campaign is a directory of markdown files with YAML frontmatter; see `content/hollow-lantern`:

- `world.md`: title, starting location, character (name, pronouns, hp, stats, inventory, and
  optionally level and xp) and quests; the body is the intro. Each quest has a definition of done
  (`done`) the world engine checks after every action, and a `reward`:

  ```yaml
  quests:
    - id: missing-lantern
      title: The Missing Lantern
      description: ...
      done:                      # complete as soon as all of these hold
        - visited: forest-depths-1
        - gave: { item: iron key, to: marta }
      reward:
        xp: 100
        items: [5 silver pennies]
  ```

  Conditions: `have: <item>` (carrying it), `gave: {item, to: <npc>}`, `at: <location>`,
  `visited: <location>`, `knows: <npc>` (has learned their name), `completed: <quest>`. A quest
  with `starts:` (same conditions) stays hidden until they hold, then begins and restores the
  player's drive; without it, a quest is active from the start. Item names ignore case, articles
  and plurals. Unknown locations and NPCs are rejected at load.
- `rules.md`: tone and rules for the narrator.
- `locations/<id>.md`: name, exits (`name: location-id`) and items; the body is the description.
  An item written with a count (`12 crates`) is a pile: "take a crate" takes one and leaves
  `11 crates`, "take the crates" takes the lot, and piles of the same thing merge in the inventory
  and wherever things are put down.
  Optional `arrival_check: {stat: wits, why: keep their nerve among the hanged men}` makes the
  player roll on first arriving (`why` reads after "trying to").
  `hidden_items` are items not visible until the player searches (`/search [where]`, or "I look
  behind the crates", "I dig…"); searching costs an action, and a found item lies in plain sight to
  be taken. Each is a name, or:

  ```yaml
  hidden_items:
    - item: ledger book
      hidden: fallen behind a few of the crates   # where/how it's hidden
      found: what the player notices on finding it
      check: {stat: wits, why: spot it}           # optional: a roll to find it
      needs: seeing stone                         # optional: only findable while carrying this
  ```

  A search aimed somewhere (`where`) finds only what's hidden there, matched by words in the
  item's name and `hidden`; a search that matches nothing in particular covers the whole place.
  The narrator never sees a hidden item until it's found (a partly failed roll gives it a hint
  that something's there), so keep them out of the location's description, which it always sees.
  Places are laid out on the map from the start location along the exits: a compass exit
  (`east`, `north`…) puts its destination one cell that way, `up`/`down` (or `upstairs`/`downstairs`)
  directly above or below it on the next level, and any other exit (`inn`, `out`) in the first free
  cell next to it on the same level (north, east, south, west). Optional `map: {x: 0, y: -1, z: -1}`
  pins a place (x grows east, y south, z is the level: 0 the ground, negative below), and `label` (8 characters at most) names it on the map; by default it's
  the name, shortened.
- `npcs/<id>.md`: name, location and the traits below; the body is the persona the NPC is played from.

### NPCs: memory and gossip

```yaml
name: Old Pell
epithet: the old man            # what the player calls them before learning the name
appearance: a hunched old man in a sodden wool coat
pronouns: he/him                # used by the model so narration and actions agree; default they/them
speech: >-                      # how they talk; optional. Quoted example lines set the sound
  Short, simple words, bad grammar ("I seen it", "ain't"), drops letters ("nothin'").
location: village-square        # where they are without a routine
routine: [village-square, village-square, village-square, hollow-lantern-inn, hollow-lantern-inn]
perception: 3                   # 1-5, default 2
discretion: open                # open | guarded | secretive, default guarded
goals: [Be believed about what he saw]
knowledge:
  - id: small-figure
    fact: Old Pell saw a small figure carry a light into the Thornwood.
    share: public               # public | trusted | secret, default public
trusts: [marta]                 # NPCs they tell "trusted" things to
```

- **Routine**: one location per turn, cycling (turn n is `routine[n % length]`), so NPCs meet.
  An NPC the player is talking with pauses their routine: talking to or giving them something
  keeps them where they are, and they carry on from where they paused once the conversation ends
  (the player leaves, or spends more than one action not addressing them). Mid-conversation, a line
  with no clear addressee is taken as said to them.
- **Perception** decides what an NPC remembers of the player's turns (`NOTICE` in
  `src/world/perception.ts`): 2 notices the player coming and going, 3 which way they went, what
  they picked up and what they did, 4 overhears their conversations. Whoever the player talks to
  always remembers the conversation.
- **Discretion** sets how far an NPC passes on what they witness or hear: open → anyone,
  guarded → only NPCs they trust, secretive → no one. Relayed information is never handled more
  loosely than the teller handled it.
- **Exchange**: when two NPCs share a location and haven't talked in 3 turns, the world engine
  works out what each is *allowed* to tell the other that they don't already know; the LLM picks
  what each actually says, based on both sets of goals. Picks outside the allowed set are dropped,
  so secrets can't leak through the model. If the player is there, they see the two talk.
- When the player talks to an NPC, the NPC draws on their goals, knowledge, what the player has given
  them and their memories, in three groups with their own allowances (`RECALL` in
  `src/world/memory.ts`), so a busy evening of comings and goings can't push out what was said:
  their last 20 exchanges with the player (both sides, word for word), the last 12 things they saw
  or overheard, and the last 15 things they heard from others.
- **No repeating**: the NPC is told not to say again what they've already told the player, and to
  move the conversation on. Their reply is also checked against everything they've said to the
  player (`src/narrative/repetition.ts`). If it repeats a sentence, a run of 8 or more words, or
  enough shorter phrases (a quarter of it), they're asked once more, with the repeated words quoted,
  and the second reply stands. Actions in *asterisks* and short lines ("Aye.") don't count.
- **Speech**: `speech` describes how an NPC talks (vocabulary, grammar, habits), and every line they
  say follows it. Example lines quoted in it set the sound, and saying one counts as repeating.
- **The player's name** has to be learned: memories call the player "the stranger" until the player
  says their name to an NPC (or within earshot of one). That gives the NPC the fact "The stranger's
  name is …", which spreads through gossip like any other.
- NPCs whose routine takes them into or out of the player's location are announced
  ("Old Pell follows you from Brackenford Square.").
- **NPC names** work the same way in reverse: the player sees an NPC by `appearance` ("a hunched old
  man in a sodden wool coat") and `epithet` ("the old man") until they hear the name spoken aloud,
  whether the NPC introduces themselves or someone mentions them ("Ask Marta at the inn"). Names in
  narration or in NPCs' *actions* don't count, and are replaced with the epithet until learned. The
  NPCs the player knows are saved as `knownNpcs` in the game state.

### Storage

`campaigns` holds each campaign's current state as JSON; `turns` holds the record of every player
action (turn number, input, intent, world events and output) as the event history; `npc_memories` holds one row per
memory per NPC (what they witnessed, talked about or heard, who from, and how far they'll share
it). The schema is created when the file is opened. JSON is stored as text, timestamps as ISO 8601
text, and `seq` (insertion order) is the integer primary key. The file uses a rollback journal
rather than WAL, which needs shared memory that a Windows drive under WSL doesn't reliably provide.
