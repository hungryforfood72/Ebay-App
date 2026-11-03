import { v2 as cloudinary } from "cloudinary";
import { NextResponse } from "next/server";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Photo formats a signed upload may be. Signed, so the browser can't
// widen it: no SVG, PDF or other files land on the account through this.
const ALLOWED_FORMATS = "jpg,jpeg,png,webp,heic,heif";

// Signs an upload request so the phone can upload photos directly to
// Cloudinary without the API secret ever reaching the client.
export async function POST() {
  const timestamp = Math.round(Date.now() / 1000);
  const folder = "ebay-listing-tool";

  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder, allowed_formats: ALLOWED_FORMATS },
    process.env.CLOUDINARY_API_SECRET as string
  );

  return NextResponse.json({
    timestamp,
    folder,
    allowedFormats: ALLOWED_FORMATS,
    signature,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  });
}
