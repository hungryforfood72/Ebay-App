"""Print helper: prints a station's 4x6 labels and packing slips on a chosen printer.

Cristian, 2026-10-21. Chrome's silent printing can only use the Windows
default printer (and drifts to whichever printer it used last), so a
station PC with a 4x6 Rollo AND a regular printer kept sending labels to
the wrong one. This runs in the background on the station PC, tells the app
which printers the PC has, and prints the 4x6 pages (packing slips,
shipping labels, local delivery labels) on the printer picked on the
station page. The small code labels still print from the station page.

Installed and updated by the installer from the station page (Printer
section, "Download installer"), into %LOCALAPPDATA%\\PrintHelper with a
config.json holding each station's key. One helper can print for several
stations (say, the packing station and the Wi-Fi Rollo slip printer).
It also updates itself from the app.

How a page prints: the job is a 4x6 HTML page. Headless Chrome (or Edge)
turns it into a PDF honoring its @page size, PyMuPDF renders it, and
pywin32 draws it on the printer at 4x6. Nothing pops up.
Log: print_helper.log next to this file.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import logging.handlers
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pymupdf
import win32api
import win32con
import win32event
import win32gui
import win32print
import win32ui
import winerror
from PIL import Image, ImageWin

VERSION = "2026-10-23.1"
HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
POLL_SECONDS = 2
CHECKIN_SECONDS = 10
UPDATE_SECONDS = 6 * 60 * 60
RENDER_DPI = 300
# 4x6 in tenths of a millimetre, as DeviceCapabilities reports paper sizes.
SIZE_4X6 = (1016, 1524)
SIZE_SLOP = 25
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
LABEL_IMG = re.compile(r'src="/api/ship/labels/([A-Za-z0-9_-]+)/image"')

log = logging.getLogger("print_helper")


# ---------------------------------------------------------------------------
# The app
# ---------------------------------------------------------------------------


def request(base: str, token: str, method: str, path: str, body: dict | None = None, raw: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("User-Agent", f"print-helper/{VERSION}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as res:
        content = res.read()
        if raw:
            return content
        return json.loads(content) if content else None


class Station:
    def __init__(self, base: str, cfg: dict):
        self.base = base
        self.id = cfg["station_id"]
        self.name = cfg.get("name") or self.id
        self.token = cfg["token"]
        self.printer: str | None = None
        self.paused = False
        self.last_checkin = 0.0
        self.last_error = ""

    def call(self, method: str, path: str, body: dict | None = None, raw: bool = False):
        return request(self.base, self.token, method, path, body, raw)

    def checkin(self, printers: list[str]):
        state = self.call("POST", "/api/print-helper/checkin", {"printers": printers, "version": VERSION}) or {}
        self.name = state.get("name") or self.name
        if state.get("printerName") != self.printer:
            log.info("%s: printer is now %s", self.name, state.get("printerName") or "(not picked yet)")
        self.printer = state.get("printerName")
        self.paused = bool(state.get("paused"))
        self.last_checkin = time.time()

    def claim(self) -> list[dict]:
        if not self.printer or self.paused:
            return []
        return self.call("GET", "/api/print-helper/jobs") or []

    def report(self, job_id: str, ok: bool, error: str | None = None):
        body = {"status": "printed"} if ok else {"status": "failed", "error": (error or "Printing failed.")[:500]}
        self.call("PATCH", f"/api/print-helper/jobs/{job_id}", body)

    def label_png(self, label_id: str) -> bytes:
        return self.call("GET", f"/api/print-helper/labels/{label_id}/image", raw=True)

    def inline_images(self, html: str) -> str:
        # A shipping label page loads its PNG from the app; fetch it with the
        # station key and put it in the page itself.
        def swap(m: re.Match) -> str:
            png = self.label_png(m.group(1))
            return 'src="data:image/png;base64,' + base64.b64encode(png).decode() + '"'

        return LABEL_IMG.sub(swap, html)


# ---------------------------------------------------------------------------
# Printing
# ---------------------------------------------------------------------------


def list_printers() -> list[str]:
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    names = {p[2] for p in win32print.EnumPrinters(flags, None, 1)}
    return sorted(names, key=str.lower)


def find_browser() -> str:
    for p in BROWSERS:
        if Path(p).exists():
            return p
    raise RuntimeError("Chrome or Edge isn't installed where expected.")


def html_to_pdf(html: str) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "page.html"
        out = Path(tmp) / "page.pdf"
        src.write_text(html, encoding="utf-8")
        subprocess.run(
            [
                find_browser(),
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-pdf-header-footer",
                # Its own profile: never touches the Chrome people use.
                f"--user-data-dir={HERE / '.browser-profile'}",
                f"--print-to-pdf={out}",
                src.as_uri(),
            ],
            check=True,
            timeout=90,
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if not out.exists() or out.stat().st_size == 0:
            raise RuntimeError("The browser didn't make the PDF.")
        return out.read_bytes()


def pdf_pages(pdf: bytes) -> list[Image.Image]:
    pages = []
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        for page in doc:
            pix = page.get_pixmap(dpi=RENDER_DPI, colorspace=pymupdf.csGRAY)
            pages.append(Image.frombytes("L", (pix.width, pix.height), pix.samples).convert("RGB"))
    return pages


def png_page(png: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(png))
    if img.mode in ("RGBA", "LA", "P"):
        # Transparent areas would print black: put it on white paper first.
        img = img.convert("RGBA")
        page = Image.new("RGB", img.size, "white")
        page.paste(img, mask=img.getchannel("A"))
        return page
    return img.convert("RGB")


def paper_4x6(printer: str, port: str) -> int | None:
    """The printer's own 4x6 paper code, if it lists one."""
    try:
        codes = win32print.DeviceCapabilities(printer, port, win32con.DC_PAPERS)
        sizes = win32print.DeviceCapabilities(printer, port, win32con.DC_PAPERSIZE)
    except Exception:
        return None
    for code, size in zip(codes, sizes):
        w, h = size["x"], size["y"]
        for a, b in ((w, h), (h, w)):
            if abs(a - SIZE_4X6[0]) <= SIZE_SLOP and abs(b - SIZE_4X6[1]) <= SIZE_SLOP:
                return code
    return None


def print_pages(printer: str, pages: list[Image.Image], title: str, copies: int):
    handle = win32print.OpenPrinter(printer)
    try:
        info = win32print.GetPrinter(handle, 2)
    finally:
        win32print.ClosePrinter(handle)
    devmode = info["pDevMode"]
    code = paper_4x6(printer, info["pPortName"])
    if code is not None:
        devmode.PaperSize = code
        devmode.Fields |= win32con.DM_PAPERSIZE
    devmode.Orientation = win32con.DMORIENT_PORTRAIT
    devmode.Fields |= win32con.DM_ORIENTATION
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


def print_job(station: Station, job: dict):
    payload = job.get("payload") or {}
    html = payload.get("html")
    if not isinstance(html, str):
        raise RuntimeError(f"Nothing to print in this {job.get('kind')} job.")
    if station.printer not in list_printers():
        raise RuntimeError(f'The printer "{station.printer}" isn\'t on this PC anymore. Pick it again on the station page.')
    if job.get("kind") == "shipping_label" and (m := LABEL_IMG.search(html)):
        # The label is already a 4x6 PNG: print it as is. Starting headless
        # Chrome for it took 1s on a good run and 15-20s on a bad one, and
        # the shipper stood waiting for it.
        pages = [png_page(station.label_png(m.group(1)))]
    else:
        pages = pdf_pages(html_to_pdf(station.inline_images(html)))
    print_pages(station.printer, pages, payload.get("code") or job.get("kind") or "Label", max(1, int(job.get("copies") or 1)))


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


def load_config() -> tuple[str, list[dict]]:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    stations = cfg.get("stations") or []
    if isinstance(stations, dict):  # one station, written as an object
        stations = [stations]
    return cfg["base_url"].rstrip("/"), [s for s in stations if s.get("station_id") and s.get("token")]


def update_self(base: str) -> bool:
    """Fetches the latest helper from the app; True when this file changed."""
    try:
        with urllib.request.urlopen(f"{base}/print-helper/print_helper.py", timeout=30) as res:
            new = res.read()
        compile(new, "print_helper.py", "exec")
    except Exception:
        log.exception("Couldn't check for an update")
        return False
    me = Path(__file__)
    if new.replace(b"\r\n", b"\n") == me.read_bytes().replace(b"\r\n", b"\n"):
        return False
    me.write_bytes(new)
    log.info("Updated itself; restarting")
    return True


def restart(mutex):
    win32api.CloseHandle(mutex)
    subprocess.Popen([sys.executable, str(Path(__file__))], cwd=str(HERE), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    sys.exit(0)


def setup_logging():
    handler = logging.handlers.RotatingFileHandler(HERE / "print_helper.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    if sys.stdout and sys.stdout.isatty():
        log.addHandler(logging.StreamHandler(sys.stdout))
    log.setLevel(logging.INFO)


def main():
    setup_logging()
    # One helper per PC: a second copy (the logon task while one runs)
    # just leaves.
    mutex = win32event.CreateMutex(None, False, "Global\\EbayToolPrintHelper")
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        return
    base, configs = load_config()
    if update_self(base):
        restart(mutex)
    stations = [Station(base, c) for c in configs]
    log.info("Print helper %s for: %s", VERSION, ", ".join(s.name for s in stations) or "(no stations)")
    printers: list[str] = []
    last_update = time.time()
    while True:
        try:
            printers = list_printers()
        except Exception:
            log.exception("Couldn't list printers")
        for st in stations:
            try:
                if time.time() - st.last_checkin >= CHECKIN_SECONDS:
                    st.checkin(printers)
                for job in st.claim():
                    code = (job.get("payload") or {}).get("code") or job["id"]
                    try:
                        print_job(st, job)
                        st.report(job["id"], True)
                        log.info("%s: printed %s on %s", st.name, code, st.printer)
                    except Exception as e:  # one bad job never stops the rest
                        log.exception("%s: failed %s", st.name, code)
                        st.report(job["id"], False, f"Print helper: {e}")
                st.last_error = ""
            except Exception as e:
                # Network down, app deploying, PC waking up: keep trying, and
                # only log the same problem once.
                text = f"{type(e).__name__}: {e}"
                if text != st.last_error:
                    log.warning("%s: %s", st.name, text)
                    st.last_error = text
                if isinstance(e, urllib.error.HTTPError) and e.code == 401:
                    time.sleep(30)
        if time.time() - last_update >= UPDATE_SECONDS:
            last_update = time.time()
            if update_self(base):
                restart(mutex)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
