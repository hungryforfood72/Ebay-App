"""Print helper: prints a station's labels and packing slips on chosen printers.

Cristian, 2026-10-21. Chrome's silent printing can only use the Windows
default printer (and drifts to whichever printer it used last), so a
station PC with a 4x6 Rollo AND a regular printer kept sending labels to
the wrong one. This runs in the background on the station PC, tells the app
which printers the PC has, and prints the 4x6 pages (packing slips,
shipping labels, local delivery labels) on the printer picked on the
station page. The small code labels (items, bins, shelves, boxes) print
from the station page unless a label printer is picked too (Cristian,
2026-10-24): then they print here, on the label size picked on the station
page (2x1, 2.25x1.25, ...). "Check for updates" on the station page makes
it update itself on its next check-in.

Installed and updated by the installer from the station page (Printer
section, "Download installer"), into %LOCALAPPDATA%\\PrintHelper with a
config.json holding each station's key. One helper can print for several
stations (say, the packing station and the Wi-Fi Rollo slip printer).
It also updates itself from the app.

How a page prints: the job is a 4x6 HTML page. Headless Chrome (or Edge)
turns it into a PDF honoring its @page size, PyMuPDF renders it, and
pywin32 draws it on the printer at 4x6. Small labels go the same way at
their label size, all the labels from one check in a single Chrome run
(a run of bin labels would otherwise start Chrome once per label), drawn
at the printer's own dpi so barcode bars stay on whole dots. Nothing
pops up.
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
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import winreg
from pathlib import Path

# The printing libraries. If one won't load, the helper used to die right
# here under pythonw with nothing logged anywhere, and the station page just
# said "Not running" (Cristian, 2026-10-25, Listing Station). Now the error
# is kept, logged and sent to the app (report_failure) before quitting.
try:
    import pymupdf
    import win32api
    import win32con
    import win32event
    import win32gui
    import win32print
    import win32ui
    import winerror
    from PIL import Image, ImageWin

    IMPORT_ERROR = None
except Exception:
    IMPORT_ERROR = traceback.format_exc()

# The USB scale. Optional: helpers installed before 2026-10-25 don't have
# it, and get it on their own (install_hidapi). Without it the station page
# keeps reading the scale through Chrome.
try:
    import hid
except Exception:
    hid = None

VERSION = "2026-10-26.1"
HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
# The code this process is running, as it was when it started. Updates are
# checked against this, not the file on disk: a reinstall can put the new
# file there while this old copy keeps running, and comparing with the disk
# would say "up to date" forever.
RUNNING = Path(__file__).read_bytes().replace(b"\r\n", b"\n")
POLL_SECONDS = 2
CHECKIN_SECONDS = 10
UPDATE_SECONDS = 6 * 60 * 60
RENDER_DPI = 300
# 4x6 in tenths of a millimetre, as DeviceCapabilities reports paper sizes.
SIZE_4X6 = (1016, 1524)
SIZE_SLOP = 25
DMPAPER_USER = 256
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
        self.label_printer: str | None = None
        self.label_size = "2x1"
        self.paused = False
        self.update_requested = False
        self.last_checkin = 0.0
        self.last_error = ""
        # Whether the app wants this station's scale readings (not a Wi-Fi
        # slip printer). Assumed yes until the first check-in says.
        self.wants_scale = True

    def call(self, method: str, path: str, body: dict | None = None, raw: bool = False):
        return request(self.base, self.token, method, path, body, raw)

    def checkin(self, printers: list[str]):
        body = {"printers": printers, "version": VERSION, "scalePolicy": scale_policy(self.base), "scale": SCALE.state}
        state = self.call("POST", "/api/print-helper/checkin", body) or {}
        self.name = state.get("name") or self.name
        if state.get("printerName") != self.printer:
            log.info("%s: printer is now %s", self.name, state.get("printerName") or "(not picked yet)")
        self.printer = state.get("printerName")
        label_size = state.get("labelSize") or "2x1"
        if state.get("labelPrinterName") != self.label_printer or label_size != self.label_size:
            log.info("%s: small labels are now %s on %s", self.name, label_size, state.get("labelPrinterName") or "(the station page)")
        self.label_printer = state.get("labelPrinterName")
        self.label_size = label_size
        self.paused = bool(state.get("paused"))
        self.update_requested = self.update_requested or bool(state.get("checkUpdate"))
        self.wants_scale = state.get("wantsScale", True) is not False
        self.last_checkin = time.time()

    def claim(self) -> list[dict]:
        if not (self.printer or self.label_printer) or self.paused:
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


def pdf_pages(pdf: bytes, dpi: int = RENDER_DPI, crisp: bool = False) -> list[Image.Image]:
    """crisp: no anti-aliasing, for barcodes drawn at the printer's dpi."""
    pages = []
    if crisp:
        pymupdf.TOOLS.set_aa_level(0)
    try:
        with pymupdf.open(stream=pdf, filetype="pdf") as doc:
            for page in doc:
                pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
                pages.append(Image.frombytes("L", (pix.width, pix.height), pix.samples).convert("RGB"))
    finally:
        if crisp:
            pymupdf.TOOLS.set_aa_level(8)
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


def paper_code(printer: str, port: str, paper: tuple[int, int]) -> int | None:
    """The printer's own paper code for this size (tenths of a mm, either
    way round), if it lists one."""
    try:
        codes = win32print.DeviceCapabilities(printer, port, win32con.DC_PAPERS)
        sizes = win32print.DeviceCapabilities(printer, port, win32con.DC_PAPERSIZE)
    except Exception:
        return None
    for code, size in zip(codes, sizes):
        w, h = size["x"], size["y"]
        for a, b in ((w, h), (h, w)):
            if abs(a - paper[0]) <= SIZE_SLOP and abs(b - paper[1]) <= SIZE_SLOP:
                return code
    return None


def inches_to_paper(width: float, height: float) -> tuple[int, int]:
    return round(width * 254), round(height * 254)


def open_printer(printer: str, paper: tuple[int, int]):
    """A device context on the printer set to this paper size. A printer
    that doesn't list the size gets it as a custom size; a driver that
    doesn't take custom sizes uses the size in its Printing preferences."""
    handle = win32print.OpenPrinter(printer)
    try:
        info = win32print.GetPrinter(handle, 2)
    finally:
        win32print.ClosePrinter(handle)
    devmode = info["pDevMode"]
    code = paper_code(printer, info["pPortName"], paper)
    if code is not None:
        devmode.PaperSize = code
        devmode.Fields |= win32con.DM_PAPERSIZE
    elif paper != SIZE_4X6:
        devmode.PaperSize = DMPAPER_USER
        devmode.PaperWidth, devmode.PaperLength = paper
        devmode.Fields |= win32con.DM_PAPERSIZE | win32con.DM_PAPERWIDTH | win32con.DM_PAPERLENGTH
    devmode.Orientation = win32con.DMORIENT_PORTRAIT
    devmode.Fields |= win32con.DM_ORIENTATION
    hdc = win32gui.CreateDC("WINSPOOL", printer, devmode)
    return win32ui.CreateDCFromHandle(hdc)


def printer_dpi(printer: str, paper: tuple[int, int]) -> int:
    dc = open_printer(printer, paper)
    try:
        return dc.GetDeviceCaps(win32con.LOGPIXELSX) or RENDER_DPI
    finally:
        dc.DeleteDC()


def print_pages(printer: str, pages: list[Image.Image], title: str, copies: int, paper: tuple[int, int] = SIZE_4X6):
    dc = open_printer(printer, paper)
    try:
        width = dc.GetDeviceCaps(win32con.HORZRES)
        height = dc.GetDeviceCaps(win32con.VERTRES)
        dc.StartDoc(title)
        for _ in range(copies):
            for img in pages:
                # A driver that lists a wide label (2.25 x 1.25) as tall
                # paper: turn the label to match.
                if (width > height) != (img.width > img.height) and width != height and img.width != img.height:
                    img = img.rotate(90, expand=True)
                # Fit the page into the printable area, centered.
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
    if job.get("target") == "label":
        print_labels(station, [job])
        return
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


def label_paper(job: dict) -> tuple[int, int]:
    size = job.get("size") or {}
    return inches_to_paper(float(size.get("width") or 2), float(size.get("height") or 1))


def label_pages(jobs: list[dict], dpi: int) -> list[Image.Image]:
    """One page per job, from one Chrome run: every job's html has the same
    head (same label size), so the bodies go into one document."""
    htmls = [(j.get("payload") or {}).get("html") for j in jobs]
    if not all(isinstance(h, str) for h in htmls):
        raise RuntimeError("Nothing to print in this label job.")
    head = htmls[0].partition("<body>")[0]
    bodies = [h.partition("<body>")[2].rpartition("</body>")[0] for h in htmls]
    pages = pdf_pages(html_to_pdf(head + "<body>" + "".join(bodies) + "</body></html>"), dpi, crisp=True)
    if len(pages) != len(jobs):
        raise RuntimeError(f"Expected {len(jobs)} label pages, got {len(pages)}.")
    return pages


def print_labels(station: Station, jobs: list[dict]):
    printer = station.label_printer
    if not printer:
        raise RuntimeError("No label printer picked on the station page.")
    if printer not in list_printers():
        raise RuntimeError(f'The printer "{printer}" isn\'t on this PC anymore. Pick it again on the station page.')
    paper = label_paper(jobs[0])
    pages = label_pages(jobs, printer_dpi(printer, paper))
    for job, page in zip(jobs, pages):
        code = (job.get("payload") or {}).get("code") or "Label"
        print_pages(printer, [page], code, max(1, int(job.get("copies") or 1)), paper)


def run_jobs(station: Station, jobs: list[dict]):
    """Prints a claim's jobs and reports each. Several labels are rendered
    together first (one Chrome run); if that fails they're tried one at a
    time, so one bad label doesn't fail the rest."""
    done: set[str] = set()
    labels = [j for j in jobs if j.get("target") == "label"]
    if len(labels) > 1:
        try:
            print_labels(station, labels)
            for job in labels:
                station.report(job["id"], True)
                done.add(job["id"])
            log.info("%s: printed %d labels on %s", station.name, len(labels), station.label_printer)
        except Exception:
            log.exception("%s: printing %d labels together failed; trying one at a time", station.name, len(labels))
    for job in jobs:
        if job["id"] in done:
            continue
        code = (job.get("payload") or {}).get("code") or job["id"]
        printer = station.label_printer if job.get("target") == "label" else station.printer
        try:
            print_job(station, job)
            station.report(job["id"], True)
            log.info("%s: printed %s on %s", station.name, code, printer)
        except Exception as e:  # one bad job never stops the rest
            log.exception("%s: failed %s", station.name, code)
            station.report(job["id"], False, f"Print helper: {e}")


# ---------------------------------------------------------------------------
# The scale
# ---------------------------------------------------------------------------
#
# The DYMO M25 read over USB (hidapi) and sent to the app, instead of the
# station page reading it through Chrome (Cristian, 2026-10-25). The M25 has
# no USB serial number, so Chrome forgot it whenever it powered off and came
# back, policy or not. Here it's just "the scale on this PC": found again
# by itself every time. Same report format as src/lib/warehouse/scale.ts:
# [3, status, unit, exponent, raw lo, raw hi]; unit 0 = display off.

DYMO_VENDOR_ID = 0x0922
POS_SCALE_USAGE_PAGE = 0x8D
SCALE_STATUS = {1: "fault", 2: "zero", 3: "moving", 4: "stable", 5: "under_zero", 6: "over_weight", 7: "needs_calibration", 8: "needs_rezero"}
GRAMS_PER_OUNCE = 28.349523125
OUNCES_PER_UNIT = {1: 0.001 / GRAMS_PER_OUNCE, 2: 1 / GRAMS_PER_OUNCE, 3: 1000 / GRAMS_PER_OUNCE, 10: 1.0971428571, 11: 1.0, 12: 16.0}
# "none" = this helper can't read USB scales (no hidapi; the reason goes
# along as "note"). A scale that isn't there is "off": the M25 on batteries
# drops off USB when it powers off, so that's what not finding it means.
SCALE_NONE = {"status": "none", "weightOz": None, "stable": False}
SCALE_OFF = {"status": "off", "weightOz": None, "stable": False}
# Readings go out the moment they change, at most this often.
SCALE_MIN_GAP = 0.25


def parse_scale_report(data) -> dict | None:
    b = [x & 0xFF for x in data]
    if len(b) >= 6 and b[0] == 3:  # report id at the front
        b = b[1:]
    if len(b) < 5:
        return None
    status = SCALE_STATUS.get(b[0])
    if not status:
        return None
    if b[1] == 0:
        return dict(SCALE_OFF)
    if status == "zero":
        return {"status": status, "weightOz": 0, "stable": True}
    per_unit = OUNCES_PER_UNIT.get(b[1])
    if status not in ("stable", "moving") or per_unit is None:
        return {"status": status, "weightOz": None, "stable": False}
    exponent = b[2] - 256 if b[2] > 127 else b[2]
    raw = b[3] | (b[4] << 8)
    return {"status": status, "weightOz": round(raw * 10**exponent * per_unit, 2), "stable": status == "stable"}


class Scale:
    """The latest reading (.state); .changed is set when it changes."""

    def __init__(self):
        self.state = dict(SCALE_NONE)
        self.changed = threading.Event()
        self.seen = False

    def set(self, state: dict):
        if state != self.state:
            self.state = state
            self.changed.set()


SCALE = Scale()


def install_hidapi():
    """Helpers installed before the scale moved here don't have hidapi:
    get it once, quietly, the way the installer does."""
    python = Path(sys.executable).with_name("python.exe")
    if not python.exists():
        python = Path(sys.executable)
    try:
        subprocess.run(
            [str(python), "-m", "pip", "install", "--user", "--disable-pip-version-check", "--no-warn-script-location", "--quiet", "hidapi"],
            check=True,
            capture_output=True,
            timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        import importlib
        import site

        user_site = site.getusersitepackages()
        if user_site not in sys.path:
            sys.path.append(user_site)
        importlib.invalidate_caches()
        import hid as module

        log.info("Installed hidapi for the scale")
        return module
    except Exception as e:
        log.warning("Couldn't install hidapi, so the station page keeps reading the scale: %s", e)
        detail = getattr(e, "stderr", b"") or b""
        SCALE.set({**SCALE_NONE, "note": f"{type(e).__name__}: {e} {detail.decode(errors='replace')[-400:]}".strip()})
        return None


def read_scale(scale: Scale):
    """Finds the scale, reads it, and finds it again whenever it drops off
    USB (powered off on batteries, unplugged). Runs forever."""
    global hid
    if hid is None:
        hid = install_hidapi()
    if hid is None:
        return  # stays "none": the station page reads it through Chrome
    dev = None
    while True:
        try:
            if dev is None:
                info = next(
                    (d for d in hid.enumerate() if d.get("vendor_id") == DYMO_VENDOR_ID or d.get("usage_page") == POS_SCALE_USAGE_PAGE),
                    None,
                )
                if info is None:
                    scale.set(dict(SCALE_OFF))
                    time.sleep(1)
                    continue
                dev = hid.device()
                dev.open_path(info["path"])
                if not scale.seen:
                    log.info("Scale: %s", info.get("product_string") or "found")
                scale.seen = True
            data = dev.read(64, 1000)
            if data:
                reading = parse_scale_report(data)
                if reading:
                    scale.set(reading)
        except Exception:
            try:
                dev.close()
            except Exception:
                pass
            dev = None
            scale.set(dict(SCALE_OFF))
            time.sleep(1)


def send_scale(scale: Scale, stations: list[Station]):
    """Sends each new reading to the app (check-ins carry it too, every
    10s, so one that fails here is caught up there)."""
    sent = None
    error = ""
    while True:
        scale.changed.wait()
        scale.changed.clear()
        state = scale.state
        if state == sent:
            continue
        for st in stations:
            if not st.wants_scale:
                continue
            try:
                st.call("POST", "/api/print-helper/scale", state)
                error = ""
            except Exception as e:
                text = f"{type(e).__name__}: {e}"
                if text != error:
                    log.warning("%s: couldn't send the scale reading: %s", st.name, text)
                    error = text
        sent = state
        time.sleep(SCALE_MIN_GAP)


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


def key_rejected(e: BaseException) -> bool:
    """The app said this station's key isn't valid (the station was deleted,
    or set up again with a new key)."""
    return isinstance(e, urllib.error.HTTPError) and e.code == 401


def forget_station(station_id: str):
    """Takes a station out of config.json, so a station with a dead key
    doesn't stop the helper from running for the ones that work (Cristian,
    2026-10-26: a reinstall on the Shipping PC failed on an old station
    still listed there, and the helper didn't start at all)."""
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
        stations = cfg.get("stations") or []
        if isinstance(stations, dict):
            stations = [stations]
        cfg["stations"] = [x for x in stations if x.get("station_id") != station_id]
        CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception:
        log.exception("Couldn't update config.json")


def load_config() -> tuple[str, list[dict]]:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    stations = cfg.get("stations") or []
    if isinstance(stations, dict):  # one station, written as an object
        stations = [stations]
    return cfg["base_url"].rstrip("/"), [s for s in stations if s.get("station_id") and s.get("token")]


def scale_policy(base: str) -> str:
    """What this PC's Chrome policy says about the DYMO scale: "set",
    "missing" or "other-site". The M25 has no USB serial number, so without
    WebHidAllowDevicesForUrls Chrome forgets it on every Chrome restart."""
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Policies\Google\Chrome") as key:
            value, _ = winreg.QueryValueEx(key, "WebHidAllowDevicesForUrls")
        rules = json.loads(value)
    except (OSError, ValueError):
        return "missing"
    origin = urllib.parse.urlsplit(base)
    dymo = False
    for rule in rules if isinstance(rules, list) else []:
        if not any(isinstance(d, dict) and d.get("vendor_id") == 0x0922 for d in rule.get("devices") or []):
            continue
        dymo = True
        for url in rule.get("urls") or []:
            u = urllib.parse.urlsplit(str(url))
            if (u.scheme, u.netloc) == (origin.scheme, origin.netloc):
                return "set"
    return "other-site" if dymo else "missing"


def report_failure(text: str):
    """Logs why the helper can't run and tells the app, so the station page
    shows it. Plain urllib only: this runs when the libraries won't load."""
    log.error("Print helper can't run:\n%s", text)
    try:
        base, configs = load_config()
    except Exception:
        log.exception("Couldn't read config.json")
        return
    body = {"version": VERSION, "error": f"Print helper {VERSION} on Python {sys.version.split()[0]}:\n{text}"[-2000:]}
    try:
        body["scalePolicy"] = scale_policy(base)
    except Exception:
        pass
    for c in configs:
        try:
            request(base, c["token"], "POST", "/api/print-helper/checkin", body)
        except Exception as e:
            log.warning("Couldn't send the error to the app: %s", e)


def check() -> int:
    """python print_helper.py --check (the installer runs it): loads
    everything and checks in once for each station, printing what went
    wrong instead of dying silently. 0 = good."""
    if IMPORT_ERROR:
        print(IMPORT_ERROR)
        report_failure(IMPORT_ERROR)
        return 1
    try:
        base, configs = load_config()
        if not configs:
            raise RuntimeError("config.json has no stations.")
        printers = list_printers()
        good = 0
        for c in configs:
            st = Station(base, c)
            try:
                st.checkin(printers)
            except Exception as e:
                if not key_rejected(e):
                    raise
                forget_station(st.id)
                print(f"{st.name}: its key isn't valid anymore (station deleted or set up again), so this PC stops printing for it.")
                continue
            good += 1
            print(f"{st.name}: checked in OK as {VERSION}. Printers: {', '.join(printers) or '(none)'}")
        if not good:
            raise RuntimeError("None of the stations in config.json are valid anymore. Download the installer from the station page again.")
        print(f"Scale setting in Chrome: {scale_policy(base)}")
        return 0
    except Exception:
        text = traceback.format_exc()
        print(text)
        report_failure(text)
        return 1


def update_self(base: str) -> bool:
    """Fetches the latest helper from the app; True when it isn't what this
    process is running (the file on disk is then the latest: restart)."""
    try:
        with urllib.request.urlopen(f"{base}/print-helper/print_helper.py?t={int(time.time())}", timeout=30) as res:
            new = res.read().replace(b"\r\n", b"\n")
        compile(new, "print_helper.py", "exec")
    except Exception:
        log.exception("Couldn't check for an update")
        return False
    if new == RUNNING:
        return False
    me = Path(__file__)
    if me.read_bytes().replace(b"\r\n", b"\n") != new:
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


def keep_checking_in(stations: list[Station]):
    """Checks in every 10s from its own thread, printing or not. When the
    main loop did it between jobs, a batch of labels (20 took ~23s) went
    quiet long enough that the station looked offline, and the station
    page printed the next batch itself on the Windows default printer
    (Cristian, 2026-10-24: bin labels came out sideways on 4x6 pages)."""
    printers: list[str] = []
    errors: dict[str, str] = {}
    while True:
        due = [st for st in stations if time.time() - st.last_checkin >= CHECKIN_SECONDS]
        if due:
            try:
                printers = list_printers()
            except Exception:
                log.exception("Couldn't list printers")  # keeps the last list
        for st in due:
            try:
                st.checkin(printers)
                errors.pop(st.id, None)
            except Exception as e:
                if key_rejected(e) and st in stations:
                    log.warning("%s: key isn't valid anymore, removing it from this PC", st.name)
                    forget_station(st.id)
                    stations.remove(st)
                    continue
                # The main loop's claim hits the same problem and logs it;
                # here only log a check-in problem once.
                text = f"{type(e).__name__}: {e}"
                if errors.get(st.id) != text:
                    log.warning("%s: check-in failed: %s", st.name, text)
                    errors[st.id] = text
                st.last_checkin = time.time() - CHECKIN_SECONDS + 3  # try again in 3s
        time.sleep(1)


def main():
    setup_logging()
    if "--check" in sys.argv:
        sys.exit(check())
    if IMPORT_ERROR:
        report_failure(IMPORT_ERROR)
        sys.exit(1)
    try:
        run()
    except SystemExit:
        raise
    except BaseException:
        report_failure(traceback.format_exc())
        raise


def run():
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
    threading.Thread(target=keep_checking_in, args=(stations,), daemon=True).start()
    threading.Thread(target=read_scale, args=(SCALE,), daemon=True).start()
    threading.Thread(target=send_scale, args=(SCALE, stations), daemon=True).start()
    last_update = time.time()
    while True:
        for st in stations:
            try:
                if st.update_requested:
                    # "Check for updates" on the station page.
                    st.update_requested = False
                    log.info("%s: asked to check for updates", st.name)
                    last_update = time.time()
                    if update_self(base):
                        restart(mutex)
                    log.info("Already the latest version (%s)", VERSION)
                run_jobs(st, st.claim())
                st.last_error = ""
            except Exception as e:
                # Network down, app deploying, PC waking up: keep trying, and
                # only log the same problem once.
                text = f"{type(e).__name__}: {e}"
                if text != st.last_error:
                    log.warning("%s: %s", st.name, text)
                    st.last_error = text
                if key_rejected(e):
                    log.warning("%s: key isn't valid anymore, removing it from this PC", st.name)
                    forget_station(st.id)
                    stations.remove(st)
                    break
        if time.time() - last_update >= UPDATE_SECONDS:
            last_update = time.time()
            if update_self(base):
                restart(mutex)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
