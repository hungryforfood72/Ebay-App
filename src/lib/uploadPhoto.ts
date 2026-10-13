// Uploads a photo straight from the browser to Cloudinary using a
// short-lived signature from our own API, so the shop-floor phone never
// sees the Cloudinary API secret and the file bytes never pass through
// our server.
export async function uploadPhoto(file: File): Promise<string> {
  const [upload, { timestamp, folder, signature, apiKey, cloudName }] =
    await Promise.all([shrinkPhoto(file), getSignature()]);

  const formData = new FormData();
  formData.append("file", upload);
  formData.append("api_key", apiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("folder", folder);

  const uploadRes = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body: formData }
  );

  if (!uploadRes.ok) throw new Error("Photo upload failed.");
  const data = await uploadRes.json();
  return data.secure_url as string;
}

type Signature = {
  timestamp: number;
  folder: string;
  signature: string;
  apiKey: string;
  cloudName: string;
};

// Cloudinary accepts a signature for an hour after its timestamp, so one
// is reused for 30 minutes instead of a round trip to our API per photo.
const SIGNATURE_REUSE_MS = 30 * 60 * 1000;
let cachedSignature: { value: Promise<Signature>; fetchedAt: number } | null = null;

function getSignature(): Promise<Signature> {
  if (cachedSignature && Date.now() - cachedSignature.fetchedAt < SIGNATURE_REUSE_MS) {
    return cachedSignature.value;
  }
  const value = fetch("/api/cloudinary-signature", { method: "POST" }).then((res) => {
    if (!res.ok) throw new Error("Could not get an upload signature.");
    return res.json() as Promise<Signature>;
  });
  cachedSignature = { value, fetchedAt: Date.now() };
  // A failed fetch shouldn't stick around for 30 minutes.
  value.catch(() => {
    if (cachedSignature?.value === value) cachedSignature = null;
  });
  return value;
}

// Phone cameras save 12-48 MP photos, often 3-8 MB each, which is what made
// uploads slow on the shop's connection. 2000px on the long side is still
// above eBay's 1600px zoom size, at a fraction of the bytes.
const MAX_EDGE_PX = 2000;
const JPEG_QUALITY = 0.85;

async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    // createImageBitmap applies the photo's EXIF rotation, so the canvas
    // copy comes out upright.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_000_000) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    // Never upload something bigger than what the camera gave us.
    return blob && blob.size < file.size ? blob : file;
  } catch {
    // Anything the browser can't decode goes up as-is, same as before.
    return file;
  }
}
