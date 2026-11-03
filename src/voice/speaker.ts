/** One line to say aloud, in one voice. */
export interface Utterance {
  text: string;
  voice: string;
  /** Seconds of silence after it. */
  pause?: number;
}

/** Reads text aloud in the background. Like LlmProvider, the rest of the app only sees this interface. */
export interface Speaker {
  /** Queues lines to be said after whatever is already queued. Returns at once. */
  speak(utterances: Utterance[]): void;
  /** Stops what's being said and drops the queue. */
  stop(): void;
  /** False if speech can't work here (it failed to load, or there's no audio player). */
  readonly available?: boolean;
  /** Loads the voice model ahead of the first line, if it has one. */
  warmUp?(): Promise<void>;
  close(): Promise<void>;
}

/** For running without sound. */
export class SilentSpeaker implements Speaker {
  speak(): void {}
  stop(): void {}
  async close(): Promise<void> {}
}
