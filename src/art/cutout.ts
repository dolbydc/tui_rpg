// Portraits cut out of their backgrounds, so that when someone is shown large over the picture of a place
// (talking with the player), it's just them there, not them and wherever they happened to be drawn. A
// background-removal model does it, on this machine's CPU with transformers.js (already here for the voices):
// BiRefNet lite by default, which handles painted and cartoon portraits (MODNet, made for photos, doesn't).
// The model is downloaded on first use (about 220 MB), and a cut takes ten seconds or so.
import { existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Cuts the subject of a picture out of its background. */
export interface Cutter {
  /** Writes `output`: `input` (a PNG) with everything but its subject transparent. */
  cut(input: string, output: string): Promise<void>;
}

export const DEFAULT_CUTOUT_MODEL = "onnx-community/BiRefNet_lite-ONNX";

/** transformers.js's background removal. The library and model load on the first cut, not before. */
export class ModelCutter implements Cutter {
  private remover?: Promise<(input: string) => Promise<{ save(path: string): Promise<void> }[]>>;

  constructor(private readonly model = DEFAULT_CUTOUT_MODEL) {}

  async cut(input: string, output: string): Promise<void> {
    this.remover ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        // Full precision: on a CPU, half precision is slower (four times, for BiRefNet), not faster.
        pipeline("background-removal", this.model, { dtype: "fp32" }) as unknown as Promise<
          (input: string) => Promise<{ save(path: string): Promise<void> }[]>
        >,
    );
    // A failed load is tried again next time, rather than remembered.
    const remove = await this.remover.catch((err: unknown) => {
      this.remover = undefined;
      throw err;
    });
    const [image] = await remove(input);
    await image.save(output);
    await harden(output);
  }
}

/** Below this much opacity a pixel is background, and goes fully transparent; above `SOLID`, fully opaque. */
const CLEAR = 48;
const SOLID = 208;

/**
 * Makes a cut-out's mask decisive: the model's is soft, leaving a faint haze where the background was and
 * the subject a little see-through. Anything mostly background becomes fully transparent, anything mostly
 * subject fully opaque, and only the thin edge between them is blended (for a smooth outline).
 */
export async function harden(file: string): Promise<void> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    data[i] = alpha <= CLEAR ? 0 : alpha >= SOLID ? 255 : Math.round(((alpha - CLEAR) / (SOLID - CLEAR)) * 255);
    // Nothing of the old background is kept, even in invisible pixels (some viewers show them).
    if (data[i] === 0) data[i - 1] = data[i - 2] = data[i - 3] = 0;
  }
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  await writeFile(file, png);
}

export interface CutoutsOptions {
  cutter: Cutter;
  /** Where cut-outs are kept: <dir>/<campaign>/people/<npc>.cutout.png, beside the drawn portraits. */
  dir: string;
  /** A cut-out is ready. */
  onReady?: (campaignId: string, npcId: string, file: string) => void;
  /** Cutting failed (the model couldn't be downloaded, say). Told once: after that none are cut. */
  onError?: (err: Error) => void;
}

/** People's portraits, cut out: each made once, in the background, one at a time, and kept. */
export class Cutouts {
  private readonly queue = new Map<string, { campaignId: string; npcId: string; source: string }>();
  private cutting?: string;
  private failed = false;
  private closed = false;

  constructor(private readonly options: CutoutsOptions) {}

  file(campaignId: string, npcId: string): string {
    return path.join(this.options.dir, campaignId, "people", `${npcId}.cutout.png`);
  }

  /**
   * The cut-out of someone's portrait (`source`), if it's been made since the portrait was; if not, it's made
   * in the background and onReady says when.
   */
  of(campaignId: string, npcId: string, source: string): string | undefined {
    const file = this.file(campaignId, npcId);
    if (existsSync(file) && statSync(file).mtimeMs >= statSync(source).mtimeMs) return file;
    if (this.failed || this.closed || this.cutting === file || this.queue.has(file)) return undefined;
    this.queue.set(file, { campaignId, npcId, source });
    if (!this.cutting) void this.work();
    return undefined;
  }

  close(): void {
    this.closed = true;
    this.queue.clear();
  }

  private async work(): Promise<void> {
    while (this.queue.size && !this.failed && !this.closed) {
      const [file, job] = this.queue.entries().next().value!;
      this.queue.delete(file);
      this.cutting = file;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        // Written whole and then moved into place, so a half-written one is never shown.
        const part = file.replace(/\.png$/, ".part.png");
        await this.options.cutter.cut(job.source, part);
        await rename(part, file);
      } catch (err) {
        this.failed = true;
        this.queue.clear();
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.cutting = undefined;
      }
      if (!this.failed && !this.closed) this.options.onReady?.(job.campaignId, job.npcId, file);
    }
  }
}
