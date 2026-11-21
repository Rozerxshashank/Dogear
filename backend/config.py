"""
Central configuration. Electron passes these as environment variables; the
defaults make the backend runnable on its own for development and tests.
"""
import os
import shutil
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Where the user's markdown notes live (visible, user-owned folder)
SMARTNOTES_DIR = os.environ.get("SMARTNOTES_DIR", str(Path.home() / "Documents" / "SmartNotes"))

# Where app-internal state lives (database, vectors, logs). Electron sets this
# to its userData folder; never relative to the current working directory.
DATA_DIR = os.environ.get("SMARTNOTES_DATA_DIR", str(Path.home() / ".smartnotes"))

DB_PATH = os.environ.get("SMARTNOTES_DB_PATH", os.path.join(DATA_DIR, "smartnotes.db"))
CHROMA_DIR = os.environ.get("SMARTNOTES_CHROMA_DIR", os.path.join(DATA_DIR, "chromadb"))
LOG_DIR = os.environ.get("SMARTNOTES_LOG_DIR", os.path.join(DATA_DIR, "logs"))

HOST = "127.0.0.1"
PORT = int(os.environ.get("SMARTNOTES_PORT", "8765"))


def _migrate_legacy_db():
    """Older builds wrote smartnotes.db into the working directory. Move it once."""
    legacy = os.path.abspath("smartnotes.db")
    if "SMARTNOTES_DB_PATH" in os.environ or os.path.exists(DB_PATH) or not os.path.exists(legacy):
        return
    if os.path.abspath(DB_PATH) == legacy:
        return
    shutil.copy2(legacy, DB_PATH)
    logging.getLogger(__name__).info(f"Copied legacy database {legacy} -> {DB_PATH}")


def setup_logging():
    os.makedirs(LOG_DIR, exist_ok=True)
    root = logging.getLogger()
    if any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        return
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "backend.log"), maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)
    root.setLevel(logging.INFO)


def init_config():
    os.makedirs(SMARTNOTES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    _migrate_legacy_db()
