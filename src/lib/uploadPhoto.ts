// Uploads a photo straight from the browser to Cloudinary using a
// short-lived signature from our own API, so the shop-floor phone never
// sees the Cloudinary API secret and the file bytes never pass through
// our server.
export async function uploadPhoto(file: File): Promise<string> {
  const sigRes = await fetch("/api/cloudinary-signature", { method: "POST" });
  if (!sigRes.ok) throw new Error("Could not get an upload signature.");
  const { timestamp, folder, signature, apiKey, cloudName } =
    await sigRes.json();

  const formData = new FormData();
  formData.append("file", file);
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
