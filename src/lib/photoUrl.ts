// Item and sale photos all live on this app's Cloudinary account (uploaded
// by the scan page through /api/cloudinary-signature). The server fetches
// and decodes these images (AI drafting, publish fixes), so a URL from a
// request body must point there and nowhere else: no other hosts, no
// internal addresses, nothing for an image decoder bug to be fed from.
export function isOurPhotoUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.port !== "") return false;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  return !cloud || url.pathname.startsWith(`/${cloud}/`);
}

export function ourPhotoUrls(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isOurPhotoUrl) : [];
}
