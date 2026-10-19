// Copies pdf.js's worker into public/ so the browser can load it as a plain
// file (the Pick orders label upload reads PDFs in the browser). Runs on
// every install, so it always matches the installed pdfjs-dist.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const from = "node_modules/pdfjs-dist/build/pdf.worker.min.mjs";
if (existsSync(from)) {
  mkdirSync("public", { recursive: true });
  copyFileSync(from, "public/pdf.worker.min.mjs");
}
