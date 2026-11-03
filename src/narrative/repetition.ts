/** Runs of this many words, shared with something said before, count as a repeated phrase. */
const PHRASE_WORDS = 5;
/** A reply with at least this share of its phrases said before is repeating itself. */
const REPEATED_SHARE = 0.25;
/** So is one that says again any run of this many words: a whole line, give or take a word. */
const REPEATED_RUN = 8;

/**
 * Whatever in `reply` was said before, in `past`: whole sentences repeated, or else the phrases it shares,
 * when they make up enough of it to notice or one runs long. Empty if the reply is fresh. Actions in
 * *asterisks* are left out: a character can sit down twice.
 */
export function repeated(reply: string, past: readonly string[]): string[] {
  const before = past.map(spoken);
  const sentences = new Set(before.flatMap(sentencesOf).map(normalise).filter(long));
  const said = spoken(reply);
  const again = sentencesOf(said).filter((s) => long(normalise(s)) && sentences.has(normalise(s)));
  if (again.length) return again;

  const known = new Set(before.flatMap(sentencesOf).flatMap((s) => phrases(words(s))));
  let total = 0;
  let shared = 0;
  const runs: string[] = [];
  for (const sentence of sentencesOf(said)) {
    const own = phrases(words(sentence));
    total += own.length;
    shared += own.filter((p) => known.has(p)).length;
    runs.push(...sharedRuns(own, known));
  }
  const noticed = total > 0 && (shared / total >= REPEATED_SHARE || runs.some((r) => r.split(" ").length >= REPEATED_RUN));
  return noticed ? runs : [];
}

/** The spoken part of a reply, without its *actions*. */
function spoken(text: string): string {
  return text.replace(/\*[^*]*\*/g, " ");
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^["“”\s]+|["“”\s]+$/g, "").trim())
    .filter(Boolean);
}

function normalise(text: string): string {
  return words(text).join(" ");
}

/** Short sentences ("Aye." "Evening.") are fair to say again. */
function long(normalised: string): boolean {
  return normalised.split(" ").length >= 4;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** Every run of PHRASE_WORDS consecutive words, in order. */
function phrases(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + PHRASE_WORDS <= list.length; i++) out.push(list.slice(i, i + PHRASE_WORDS).join(" "));
  return out;
}

/** One sentence's phrases said before, joined back into the longer runs of words they came from. */
function sharedRuns(own: string[], known: Set<string>): string[] {
  const runs: string[][] = [];
  let run: string[] | undefined;
  for (const phrase of own) {
    if (!known.has(phrase)) run = undefined;
    else if (run) run.push(phrase.split(" ").at(-1)!);
    else runs.push((run = phrase.split(" ")));
  }
  return runs.map((r) => r.join(" "));
}
