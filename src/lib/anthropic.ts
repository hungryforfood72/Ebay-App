import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

export const anthropic = new Anthropic();

export type SupportedImageType = "image/jpeg";

// Phone camera photos are routinely several MB each. A single-item draft
// only ever sends one photo, so this stayed latent, but a bundle draft
// sends the hero photo plus every component's photo in the same request —
// a real bundle upload hit Anthropic's "413 request_too_large" this way.
// Resize + re-encode every image before it goes anywhere near the API so
// this can't happen regardless of how many photos or how large the
// originals are.
const MAX_DIMENSION = 1568; // Anthropic's own recommended max — bigger doesn't improve recognition, just cost/size
const JPEG_QUALITY = 82;

export async function fetchImageAsBase64(
  url: string
): Promise<{ data: string; mediaType: SupportedImageType }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const original = Buffer.from(await res.arrayBuffer());
  const resized = await sharp(original)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { data: resized.toString("base64"), mediaType: "image/jpeg" };
}
