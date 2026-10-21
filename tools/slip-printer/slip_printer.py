"""Slip printer helper: prints packing slips on the Wi-Fi Rollo.

Cristian, 2026-10-21: packing slips go to the Wi-Fi Rollo on their own,
with no station PC or browser tab in the loop. This runs on any Windows PC
on the shop network that has the Rollo installed as a printer ("Rollo
X1040"). It signs in to the app as its own user, says it's online (so the
app sends slips here; if this PC is off, slips fall back to the packing
station), picks up queued slips, and prints them.

How a slip prints: the job is a 4x6 HTML page. Headless Chrome turns it
into a PDF (honoring its @page 4in x 6in), PyMuPDF renders each page, and
pywin32 draws it on the printer at 4x6. Nothing pops up.

Setup (once):
  1. In the app: Settings -> Users, add a user for this helper (for example
     "slip-printer", employee). Its sales/activity show under that name.
  2. Copy config.example.json to config.json here and fill in that user's
     password. config.json stays on this PC (git-ignored).
  3. pip install pymupdf pywin32
  4. Run run_slip_printer.pyw (no window). install_startup.ps1 makes it
     start at logon.
Log: slip_printer.log next to this file.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

import pymupdf
import win32con
import win32gui
import win32print
import win32ui
from PIL import Image, ImageWin

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
POLL_SECONDS = 2
HEARTBEAT_SECONDS = 10
# The only jobs that come here (src/lib/warehouse/packingSlip.ts). Anything
# else is reported failed, not printed on a 4x6.
PAGE_KINDS = {"packing_slip", "delivery_label"}
# "North America 4x 6" on the Rollo's IPP driver (DeviceCapabilities).
PAPER_4X6 = 136
RENDER_DPI = 300
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]

log = logging.getLogger("slip_printer")


class App:
    """The app's API, signed in as the helper's user (session cookie)."""

    def __init__(self, cfg: dict):
        self.base = cfg["base_url"].rstrip("/")
        self.username = cfg["username"]
        self.password = cfg["password"]
        self.station = cfg["station_id"]
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def _call(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with self.opener.open(req, timeout=30) as res:
            raw = res.read()
            return json.loads(raw) if raw else None

    def call(self, method: str, path: str, body: dict | None = None):
        try:
            return self._call(method, path, body)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            self.login()
            return self._call(method, path, body)

    def login(self):
        self._call("POST", "/api/auth", {"username": self.username, "password": self.password})
        log.info("Signed in as %s", self.username)

    def heartbeat(self):
        self.call("POST", f"/api/stations/{self.station}/heartbeat", {"weightOz": None, "stable": False})

    def claim_jobs(self) -> list[dict]:
        return self.call("GET", f"/api/stations/{self.station}/jobs") or []

    def report(self, job_id: str, ok: bool, error: str | None = None):
        body = {"status": "printed"} if ok else {"status": "failed", "error": (error or "Printing failed.")[:500]}
        self.call("PATCH", f"/api/print-jobs/{job_id}", body)


def find_chrome() -> str:
    for p in CHROME_PATHS:
        if Path(p).exists():
            return p
    raise RuntimeError("Chrome isn't installed where expected.")


def html_to_pdf(html: str, chrome: str) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "slip.html"
        out = Path(tmp) / "slip.pdf"
        src.write_text(html, encoding="utf-8")
        subprocess.run(
            [
                chrome,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-pdf-header-footer",
                # Its own profile: never touches the Chrome people use.
                f"--user-data-dir={HERE / '.chrome-profile'}",
                f"--print-to-pdf={out}",
                src.as_uri(),
            ],
            check=True,
            timeout=60,
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if not out.exists() or out.stat().st_size == 0:
            raise RuntimeError("Chrome didn't make the PDF.")
        return out.read_bytes()


def pdf_pages(pdf: bytes) -> list[Image.Image]:
    pages = []
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        for page in doc:
            pix = page.get_pixmap(dpi=RENDER_DPI, colorspace=pymupdf.csGRAY)
            pages.append(Image.frombytes("L", (pix.width, pix.height), pix.samples).convert("RGB"))
    return pages


def print_pages(printer: str, pages: list[Image.Image], title: str, copies: int):
    handle = win32print.OpenPrinter(printer)
    try:
        devmode = win32print.GetPrinter(handle, 2)["pDevMode"]
    finally:
        win32print.ClosePrinter(handle)
    devmode.PaperSize = PAPER_4X6
    devmode.Orientation = win32con.DMORIENT_PORTRAIT
    devmode.Fields |= win32con.DM_PAPERSIZE | win32con.DM_ORIENTATION
    hdc = win32gui.CreateDC("WINSPOOL", printer, devmode)
    dc = win32ui.CreateDCFromHandle(hdc)
    try:
        width = dc.GetDeviceCaps(win32con.HORZRES)
        height = dc.GetDeviceCaps(win32con.VERTRES)
        dc.StartDoc(title)
        for _ in range(copies):
            for img in pages:
                # Fit the 4x6 page into the printable area, centered.
                scale = min(width / img.width, height / img.height)
                w, h = int(img.width * scale), int(img.height * scale)
                x, y = (width - w) // 2, (height - h) // 2
                dc.StartPage()
                ImageWin.Dib(img).draw(dc.GetHandleOutput(), (x, y, x + w, y + h))
                dc.EndPage()
        dc.EndDoc()
    finally:
        dc.DeleteDC()


def print_job(job: dict, printer: str, chrome: str):
    payload = job.get("payload") or {}
    html = payload.get("html")
    if job.get("kind") not in PAGE_KINDS or not isinstance(html, str):
        raise RuntimeError(f"This printer only prints packing slips, not {job.get('kind')}.")
    pages = pdf_pages(html_to_pdf(html, chrome))
    print_pages(printer, pages, payload.get("code") or "Packing slip", max(1, int(job.get("copies") or 1)))


def setup_logging():
    handler = logging.handlers.RotatingFileHandler(HERE / "slip_printer.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    if sys.stdout and sys.stdout.isatty():
        log.addHandler(logging.StreamHandler(sys.stdout))
    log.setLevel(logging.INFO)


def load_config() -> dict:
    # Until the password is filled in, wait and check again, so it starts
    # by itself once config.json is done (no restart needed).
    warned = False
    while True:
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
            if all(cfg.get(k) for k in ("base_url", "username", "password", "station_id")):
                return cfg
        except (OSError, ValueError):
            pass
        if not warned:
            log.warning("config.json isn't filled in yet (password?). Checking again every minute.")
            warned = True
        time.sleep(60)


def main():
    setup_logging()
    cfg = load_config()
    printer = cfg.get("printer", "Rollo X1040")
    chrome = find_chrome()
    app = App(cfg)
    log.info("Starting: printer %s, station %s", printer, app.station)
    last_beat = 0.0
    while True:
        try:
            if time.time() - last_beat >= HEARTBEAT_SECONDS:
                app.heartbeat()
                last_beat = time.time()
            for job in app.claim_jobs():
                code = (job.get("payload") or {}).get("code") or job["id"]
                try:
                    print_job(job, printer, chrome)
                    app.report(job["id"], True)
                    log.info("Printed %s", code)
                except Exception as e:  # one bad job never stops the rest
                    log.exception("Failed %s", code)
                    app.report(job["id"], False, f"Slip printer: {e}")
        except Exception:
            # Network down, app deploying, PC waking up: keep trying.
            log.exception("Loop error")
            time.sleep(10)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    if "--test" in sys.argv:
        # Print one test page without the app: python slip_printer.py --test
        setup_logging()
        cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
        test = """<!doctype html><html><head><style>@page { size: 4in 6in; margin: 0; }
body { margin: 0; font-family: Arial; } .p { width: 4in; height: 6in; box-sizing: border-box; border: 4px solid #000;
display: flex; flex-direction: column; align-items: center; justify-content: center; }
h1 { font-size: 30pt; margin: 0; } p { font-size: 13pt; }</style></head><body><div class="p">
<h1>TEST SLIP</h1><p>Wi-Fi Rollo slip printer works.</p><p>The border should sit just inside the label.</p></div></body></html>"""
        pages = pdf_pages(html_to_pdf(test, find_chrome()))
        print_pages(cfg.get("printer", "Rollo X1040"), pages, "Slip printer test", 1)
        print(f"Sent {len(pages)} page(s).")
    else:
        main()
