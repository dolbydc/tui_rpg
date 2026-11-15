// Draws pictures with a ComfyUI server (https://github.com/comfyanonymous/ComfyUI): queue a workflow with the
// prompt in it, wait for it to finish, fetch the image it saved.

/** The models ComfyUI can draw with, by the files their workflows load (in ComfyUI's models folder). */
export const COMFY_MODELS = ["moss", "zimage"] as const;
export type ComfyModel = (typeof COMFY_MODELS)[number];

/** Places are drawn wide, people upright; both ~1 megapixel, which is what both models draw best. */
export type Shape = "landscape" | "portrait";
const SIZES: Record<Shape, { width: number; height: number }> = {
  landscape: { width: 1216, height: 832 },
  portrait: { width: 896, height: 1152 },
};

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * Text-to-image workflows in ComfyUI's API format, as in its bundled templates (image_moss_image_t2i,
 * image_z_image_turbo_int8) without their optional extras. MOSS-Image comes with ComfyUI Desktop; it's
 * the better picture, at ~30 s on a 12 GB card. Z-Image-Turbo is 8 steps instead of 25.
 */
export function workflow(model: ComfyModel, prompt: string, seed: number, shape: Shape = "landscape"): Workflow {
  const { width: WIDTH, height: HEIGHT } = SIZES[shape];
  const save = { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "tui_rpg" } };
  switch (model) {
    case "moss":
      return {
        unet: { class_type: "UNETLoader", inputs: { unet_name: "moss_image_sft_int8_convrot.safetensors", weight_dtype: "default" } },
        clip: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3.5_9b_w4a8_gptq.safetensors", type: "moss_image", device: "default" } },
        vae: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae_small.safetensors" } },
        positive: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: prompt } },
        negative: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: "" } },
        latent: { class_type: "EmptyFlux2LatentImage", inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
        sample: {
          class_type: "KSampler",
          inputs: {
            model: ["unet", 0], seed, steps: 25, cfg: 2.5, sampler_name: "er_sde", scheduler: "simple",
            positive: ["positive", 0], negative: ["negative", 0], latent_image: ["latent", 0], denoise: 1,
          },
        },
        decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } },
        save,
      };
    case "zimage":
      return {
        unet: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_int8_convrot.safetensors", weight_dtype: "default" } },
        clip: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b_fp8_mixed.safetensors", type: "lumina2", device: "default" } },
        vae: { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
        shift: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["unet", 0], shift: 3 } },
        positive: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: prompt } },
        negative: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["positive", 0] } },
        latent: { class_type: "EmptySD3LatentImage", inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
        sample: {
          class_type: "KSampler",
          inputs: {
            model: ["shift", 0], seed, steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple",
            positive: ["positive", 0], negative: ["negative", 0], latent_image: ["latent", 0], denoise: 1,
          },
        },
        decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } },
        save,
      };
  }
}

export interface ComfyOptions {
  /** e.g. http://127.0.0.1:8188 */
  url: string;
  model?: ComfyModel;
  /** Give up on a picture after this long. */
  timeoutMs?: number;
  /** How often to ask whether it's done. */
  pollMs?: number;
}

export interface DrawOptions {
  signal?: AbortSignal;
  shape?: Shape;
}

/** What draws a picture from a prompt: ComfyUI, or a stand-in in tests. */
export interface Painter {
  /** A PNG. */
  draw(prompt: string, seed: number, options?: DrawOptions): Promise<Buffer>;
}

interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export class ComfyPainter implements Painter {
  private readonly url: string;
  private readonly model: ComfyModel;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor({ url, model = "moss", timeoutMs = 300_000, pollMs = 1000 }: ComfyOptions) {
    this.url = url.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
  }

  async draw(prompt: string, seed: number, { signal, shape }: DrawOptions = {}): Promise<Buffer> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const queued = await this.json<{ prompt_id?: string; error?: unknown; node_errors?: unknown }>("/prompt", abort, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow(this.model, prompt, seed, shape) }),
    });
    if (!queued.prompt_id) throw new Error(`ComfyUI wouldn't take the workflow: ${rejection(queued)}`);
    for (;;) {
      await sleep(this.pollMs, abort);
      const history = await this.json<Record<string, HistoryEntry>>(`/history/${queued.prompt_id}`, abort);
      const entry = history[queued.prompt_id];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        const failed = entry.status.messages?.find(([kind]) => kind === "execution_error")?.[1];
        throw new Error(`ComfyUI couldn't draw it: ${failed?.exception_message?.trim() ?? "the workflow failed"}`);
      }
      const image = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
      if (!image) {
        if (entry.status?.completed) throw new Error("ComfyUI finished without a picture");
        continue;
      }
      const response = await this.fetch(`/view?${new URLSearchParams({ ...image })}`, abort);
      return Buffer.from(await response.arrayBuffer());
    }
  }

  private async fetch(endpoint: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${endpoint}`, { ...init, signal });
    } catch (err) {
      if (signal.aborted) throw new Error(`ComfyUI took too long (${this.timeoutMs / 1000} s)`);
      throw new Error(`couldn't reach ComfyUI at ${this.url} (${err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : err})`);
    }
    if (!response.ok && response.status !== 400) throw new Error(`ComfyUI ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  }

  private async json<T>(endpoint: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
    return (await (await this.fetch(endpoint, signal, init)).json()) as T;
  }
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] };
  outputs?: Record<string, { images?: ImageRef[] }>;
}

/** Why ComfyUI turned a workflow down: a model file it hasn't got, usually ("unet_name: 'x' not in [...]"). */
function rejection(reply: { error?: unknown; node_errors?: unknown }): string {
  const nodes = Object.values((reply.node_errors ?? {}) as Record<string, { errors?: { message?: string; details?: string }[] }>);
  const first = nodes.flatMap((n) => n.errors ?? [])[0];
  if (first) return [first.message, first.details].filter(Boolean).join(": ").slice(0, 300);
  const error = reply.error as { message?: string } | undefined;
  return (error?.message ?? JSON.stringify(reply)).slice(0, 300);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("ComfyUI took too long"))), { once: true });
  });
}
