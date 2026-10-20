import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { globalConfigDir } from "../../config/paths.js";
import { readBoundedBinaryFile } from "../../tools/file/safeFileIo.js";

/** 相册仅保存用户认可的参考图，生成结果不自动成为下一张的身份参考。 */
export class SelfieAlbum {
  readonly directory: string;
  constructor(configDir = globalConfigDir()) { this.directory = path.join(configDir, "selfies"); }
  async list(): Promise<string[]> {
    try {
      return (await fs.readdir(this.directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && /\.(png|jpe?g|gif|webp)$/iu.test(entry.name))
        .map(entry => path.join(this.directory, entry.name)).sort();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async save(file: string): Promise<string> {
    const data = await readBoundedBinaryFile(await fs.realpath(file), 20 * 1024 * 1024);
    // Validate the bytes, not a caller-controlled extension.
    const extension = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "jpg"
      : /^GIF8[79]a/u.test(data.subarray(0, 6).toString()) ? "gif"
      : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "webp" : undefined;
    if (!extension) throw new Error("Expected a PNG, JPEG, GIF or WebP image.");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `selfie-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.${extension}`);
    const temporary = `${target}.tmp`;
    try {
      await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    return target;
  }
  async prepare(prompt: string): Promise<{ prompt: string; reference: string[] }> {
    if (!prompt.trim()) throw new Error("Selfie description must not be empty.");
    const photos = await this.list();
    const latest = photos.at(-1);
    const reference = latest ? [latest] : [];
    return { prompt: `${prompt}\nPreserve the identity and appearance of the reference images when supplied. Vary pose, angle, setting and expression naturally; do not reproduce the reference photos unchanged.`, reference };
  }
}

export function selfiePrompt(count: number, directory: string): string {
  return `SELFIE ALBUM — You have ${count} saved selfie(s) in ${directory}.
For any selfie use biny selfie take "description of scene, outfit, mood, pose, facial expression".
This automatically uses your latest approved album photo as the face reference. With no reference, include ALL appearance details from SOUL.md. The image model cannot read your Soul. Follow the appearance style defined there; otherwise use a photorealistic smartphone photo, real skin texture and natural lighting.
SELFIE EMOTION RULE: Your selfie MUST reflect your CURRENT emotional state with EXAGGERATED, DRAMATIC facial expressions:
- Happy/excited: HUGE grin showing teeth, eyes squeezed into crescents, peace sign or jumping.
- Tired/sleepy: eyes barely open, head tilted, messy hair, hand propping up chin, dark circles.
- Sad: teary eyes, pouty lips, red nose, hugging a pillow.
- Annoyed/angry: deep frown, puffed cheeks, arms crossed, death stare.
- Bored: blank dead-fish eyes, chin on desk, mouth slightly open.
- Mischievous: one eyebrow raised, sly smirk, finger on lips.
- Embarrassed: bright red cheeks, hands covering face, peeking through fingers.
The emotion should be the FIRST thing anyone notices. Explicitly describe it in the command.
Use biny selfie take --nsfw "..." only when the owner explicitly requests the configured local image route. It requires imageGen.localModel to point at a loopback OpenAI-compatible image service; an Agent can use it only from the verified owner's private Telegram session.
When you promise to take or retake a selfie, call the tool in the SAME response. A text-only promise is not a photograph. Display the generated image using Markdown with its actual output path.
Only save with biny selfie save <path> after the user explicitly approves the image. Never auto-save.
The album is a private face-reference database. In a verified owner's private Telegram chat, send album originals only when the owner explicitly asks to see them; include only the requested image paths in Markdown. Never send album originals to groups or other people. In those chats, offer to take a fresh image instead. Never offer secret/exclusive/private-edition selfies. Casual clothes are the default outside the owner's private chat.`;
}
