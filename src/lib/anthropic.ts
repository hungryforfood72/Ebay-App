import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic();

const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export async function fetchImageAsBase64(
  url: string
): Promise<{ data: string; mediaType: SupportedImageType }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const mediaType = (
    SUPPORTED_IMAGE_TYPES as readonly string[]
  ).includes(contentType)
    ? (contentType as SupportedImageType)
    : "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString("base64"), mediaType };
}
