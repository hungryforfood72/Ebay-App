// Uploads a photo straight from the browser to Cloudinary using a
// short-lived signature from our own API, so the shop-floor phone never
// sees the Cloudinary API secret and the file bytes never pass through
// our server.
//
// onPrepared gets the exact image going up, so a preview can show it turned
// upright instead of the camera's original.
export async function uploadPhoto(file: File, onPrepared?: (image: Blob) => void): Promise<string> {
  const [upload, { timestamp, folder, signature, apiKey, cloudName }] =
    await Promise.all([shrinkPhoto(file), getSignature()]);
  if (upload !== file) onPrepared?.(upload);

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
    const turn = await uprightTurn(file);
    // createImageBitmap applies the photo's EXIF rotation, so the canvas
    // copy comes out the way the camera thought was up. `turn` then fixes
    // a wrong guess.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    if (turn === 0 && scale === 1 && file.size < 1_000_000) {
      bitmap.close();
      return file;
    }
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const sideways = turn === 90 || turn === 270;
    const canvas = document.createElement("canvas");
    canvas.width = sideways ? height : width;
    canvas.height = sideways ? width : height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((turn * Math.PI) / 180);
    ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    if (!blob) return file;
    // Never upload something bigger than what the camera gave us, unless
    // the camera's copy is the wrong way up.
    return turn !== 0 || blob.size < file.size ? blob : file;
  } catch {
    // Anything the browser can't decode goes up as-is, same as before.
    return file;
  }
}

// The camera app decides which way is up from the device's tilt sensor,
// and when the scanner is pointed down at an item on a table that guess
// flips around, so some photos came out sideways or upside down. Nobody
// holds the scanner sideways on purpose, so the way it usually saves
// photos is the right way: this device's most common EXIF orientation,
// counted from its own fresh camera shots. A photo saved any other way
// gets turned to match. Gallery picks (older files) are left alone.
const ORIENTATION_TALLY_KEY = "ebay-tool.photoOrientationTally";
const FRESH_PHOTO_MS = 10 * 60 * 1000;
const MIN_SHOTS_TO_TRUST = 5;
const MIN_SHARE_TO_TRUST = 0.6;
// EXIF orientation -> degrees clockwise the camera says to turn the saved
// pixels. Mirrored values (2, 4, 5, 7) never come from a rear camera.
const ORIENTATION_DEGREES: Record<number, number> = { 1: 0, 6: 90, 3: 180, 8: 270 };

async function uprightTurn(file: File): Promise<number> {
  if (Date.now() - file.lastModified > FRESH_PHOTO_MS) return 0;
  const orientation = await readExifOrientation(file).catch(() => null);
  if (orientation == null || !(orientation in ORIENTATION_DEGREES)) return 0;

  let tally: Record<string, number> = {};
  try {
    tally = JSON.parse(localStorage.getItem(ORIENTATION_TALLY_KEY) ?? "{}");
    tally[orientation] = (tally[orientation] ?? 0) + 1;
    localStorage.setItem(ORIENTATION_TALLY_KEY, JSON.stringify(tally));
  } catch {
    return 0;
  }

  const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
  const [usual, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (total < MIN_SHOTS_TO_TRUST || count / total < MIN_SHARE_TO_TRUST) return 0;
  return (ORIENTATION_DEGREES[Number(usual)] - ORIENTATION_DEGREES[orientation] + 360) % 360;
}

// Reads the orientation tag (0x0112) from a JPEG's EXIF block, or null
// when there isn't one.
async function readExifOrientation(file: File): Promise<number | null> {
  const view = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 10 > view.byteLength) return null;
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
      }
      return null;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
    offset += 2 + length;
  }
  return null;
}
