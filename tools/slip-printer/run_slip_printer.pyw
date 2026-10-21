# Starts the slip printer with no console window (pythonw). See slip_printer.py.
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).with_name("slip_printer.py")), run_name="__main__")
