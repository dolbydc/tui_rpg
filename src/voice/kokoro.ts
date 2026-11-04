import { Worker } from "node:worker_threads";
import { systemPlayer, type AudioPlayer, type Playback } from "./players.js";
import type { Speaker, Utterance } from "./speaker.js";

interface Audio {
  samples: Float32Array;
  rate: number;
  pause?: number;
}

/** Silence at the end of each line of text: after a heading, the exits, who's here… */
export const LINE_PAUSE = 0.375;

/**
 * How much of the silence Kokoro puts around each sentence is kept (about 0.26 s before and 0.7 s after):
 * all of it makes too long a pause between sentences.
 */
export const SILENCE_KEPT = 0.75;

export interface KokoroOptions {
  /** Told once, when speech can't work (no model, no audio player); after that the speaker stays silent. */
  onError?: (err: Error) => void;
  /** What plays the audio; by default, whatever this system has (see systemPlayer). */
  player?: AudioPlayer;
}

/**
 * Local text-to-speech with Kokoro (an 80 MB ONNX model, run on the CPU so the GPU stays with the LLM, in a
 * worker thread so the TUI stays responsive), played through the system's own player (see players.ts).
 * Each line is generated while the one before it plays, so long narration starts after its first
 * sentence.
 */
export class KokoroSpeaker implements Speaker {
  private readonly onError: (err: Error) => void;
  private worker?: Promise<Worker>;
  private readonly waiting = new Map<number, (audio: Audio | undefined) => void>();
  private nextId = 0;
  private queue: Utterance[] = [];
  /** Bumped by stop(), so audio generated for what was stopped is thrown away. */
  private generation = 0;
  private running = false;
  private readonly player: AudioPlayer;
  private playing?: Playback;
  private broken = false;

  /** False once speech has failed for good (see onError). */
  get available(): boolean {
    return !this.broken;
  }

  constructor({ onError = () => {}, player = systemPlayer() }: KokoroOptions = {}) {
    this.onError = onError;
    this.player = player;
  }

  async warmUp(): Promise<void> {
    await this.load();
  }

  speak(utterances: Utterance[]): void {
    if (this.broken) return;
    this.queue.push(...utterances.flatMap(sentences));
    void this.run();
  }

  stop(): void {
    this.generation++;
    this.queue = [];
    this.playing?.stop();
    // Lines already sent to the worker but not yet started are dropped there too.
    void this.worker?.then((worker) => worker.postMessage({ stop: this.generation })).catch(() => {});
  }

  async close(): Promise<void> {
    this.stop();
    this.player.close();
    if (this.worker) await (await this.worker.catch(() => undefined))?.terminate();
  }

  /** Starts the worker, which loads the model, and resolves once it's ready. */
  private load(): Promise<Worker> {
    this.worker ??= new Promise((resolve, reject) => {
      const worker = startWorker();
      worker.unref();
      worker.on("error", reject);
      worker.on("message", (message: WorkerReply) => {
        if ("ready" in message) resolve(worker);
        else if ("failed" in message) reject(new Error(message.failed));
        else {
          this.waiting.get(message.id)?.("samples" in message ? message : undefined);
          this.waiting.delete(message.id);
        }
      });
    });
    return this.worker;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const worker = await this.load();
      let pending: { generation: number; audio: Promise<Audio | undefined> } | undefined;
      const next = () => {
        const utterance = this.queue.shift();
        return (
          utterance && {
            generation: this.generation,
            audio: this.synthesize(worker, utterance, this.generation).then((a) => a && { ...a, pause: utterance.pause }),
          }
        );
      };
      while ((pending ??= next())) {
        const current = pending;
        const audio = await current.audio;
        pending = next();
        if (audio && current.generation === this.generation) await this.play(audio);
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.running = false;
    }
  }

  /** Undefined if the worker couldn't say it (an unknown voice, odd text): that line is skipped. */
  private synthesize(worker: Worker, { text, voice }: Utterance, generation: number): Promise<Audio | undefined> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      worker.postMessage({ id, text, voice, generation });
    });
  }

  private play({ samples: generated, rate, pause = 0 }: Audio): Promise<void> {
    const speech = trimSilence(generated, SILENCE_KEPT);
    // The pause is played as silence after the speech, so it's part of the line and Tab skips it too.
    const samples = new Float32Array(speech.length + Math.round(rate * pause));
    samples.set(speech);
    this.playing = this.player.play(samples, rate);
    return this.playing.done.catch((err: unknown) => this.fail(err));
  }

  private fail(err: unknown): void {
    if (this.broken) return;
    this.broken = true;
    this.queue = [];
    this.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Below this, a sample is silence. */
const QUIET = 0.01;

/** The speech with only `kept` of the silence before and after it. */
export function trimSilence(samples: Float32Array, kept: number): Float32Array {
  const first = samples.findIndex((s) => Math.abs(s) > QUIET);
  if (first === -1) return samples;
  let last = samples.length - 1;
  while (Math.abs(samples[last]) <= QUIET) last--;
  const trail = samples.length - 1 - last;
  return samples.subarray(first - Math.round(first * kept), last + 1 + Math.round(trail * kept));
}

type WorkerReply =
  | { id: number; samples: Float32Array; rate: number }
  | { id: number; error: string }
  | { ready: true }
  | { failed: string };

/**
 * The speech worker, which generates audio off the main thread: it's CPU-heavy, and on the main thread it
 * freezes the TUI (keypresses pile up until it finishes). It's plain JavaScript so it runs the same under
 * tsx and built; it's told where kokoro-js is, since an inline worker resolves modules from the cwd.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
// kokoro-js finds its voice files from __dirname when there is one; an inline worker's is ".", so hide it.
delete globalThis.__dirname;
import(workerData.kokoro).then(({ KokoroTTS }) => KokoroTTS.from_pretrained(workerData.model, { dtype: workerData.dtype, device: "cpu" })).then(
  (tts) => {
    // kokoro-js only lets English voices speak, and only in their own accent: the first letter of the voice
    // is its language. The others (Spanish ef_dora, em_alex, em_santa; French, Italian, Portuguese, Hindi,
    // Japanese, Mandarin) are let through to read English too, as American English, in their own accent.
    const validate = tts._validate_voice.bind(tts);
    tts._validate_voice = (voice) => (/^[efhijpz][fm]_/.test(voice) ? "a" : validate(voice));
    parentPort.postMessage({ ready: true });
    let queue = Promise.resolve();
    // Requests from before the last stop are dropped unsaid.
    let current = 0;
    parentPort.on("message", ({ id, text, voice, generation, stop }) => {
      if (stop !== undefined) {
        current = stop;
        return;
      }
      queue = queue.then(async () => {
        if (generation < current) return parentPort.postMessage({ id, error: "stopped" });
        try {
          const audio = await tts.generate(text, { voice });
          const samples = new Float32Array(audio.audio);
          parentPort.postMessage({ id, samples, rate: audio.sampling_rate }, [samples.buffer]);
        } catch (err) {
          parentPort.postMessage({ id, error: String(err) });
        }
      });
    });
  },
  (err) => parentPort.postMessage({ failed: err instanceof Error ? err.message : String(err) }),
);`;

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** Full precision: on a desktop CPU it was both the best quality and faster than q8 (1.5 s vs 2.7 s for 5 s of speech). */
const DTYPE = "fp32";

function startWorker(): Worker {
  return new Worker(WORKER, {
    eval: true,
    workerData: { kokoro: import.meta.resolve("kokoro-js"), model: MODEL, dtype: DTYPE },
  });
}

/**
 * Kokoro reads a sentence or two at a time best; long narration is split so it starts sooner, too. Each
 * line of text (a heading, "Exits: …", "People here: …") ends in a full stop, so it's spoken as one, and a
 * pause.
 */
export function sentences(utterance: Utterance): Utterance[] {
  return utterance.text.split(/\n+/).flatMap((line) => {
    const text = line.trim();
    if (!/\w/.test(text)) return [];
    const ended = /[.!?…]["”’)]*$/.test(text) ? text : `${text}.`;
    const parts = (ended.match(/[^.!?…]+[.!?…]+["”’)]*/g) ?? [ended]).map((p) => p.trim()).filter((p) => /\w/.test(p));
    return parts.map((part, i): Utterance => ({ ...utterance, text: part, ...(i === parts.length - 1 ? { pause: LINE_PAUSE } : {}) }));
  });
}
