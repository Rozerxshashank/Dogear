"""
File helpers shared by notes, sync, import and reconcile.
Notes live at SMARTNOTES_DIR/<folder>/<title>.md; `folder` uses "/" separators.
"""
import os
import re
import hashlib
import tempfile

from backend import config

_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def notes_root() -> str:
    return os.path.abspath(config.SMARTNOTES_DIR)


def compute_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _clean_segment(segment: str) -> str:
    s = _ILLEGAL.sub("", segment).strip().strip(".").strip()
    if s.lower() in _RESERVED:
        s = f"_{s}"
    return s[:120]


def sanitize_title(title: str) -> str:
    """Make a title safe to use as a filename (without extension)."""
    s = _clean_segment(title or "")
    return s if s else "Untitled"


def sanitize_folder(folder: str) -> str:
    """Normalize a folder path: no traversal, no hidden dirs, "/" separators."""
    parts = re.split(r"[\\/]+", folder or "")
    clean = []
    for part in parts:
        if part.strip().startswith("."):
            continue  # ".", "..", and hidden folders like .git / .obsidian
        seg = _clean_segment(part)
        if seg:
            clean.append(seg)
    return "/".join(clean)


def folder_path(folder: str) -> str:
    folder = sanitize_folder(folder)
    path = os.path.join(notes_root(), *folder.split("/")) if folder else notes_root()
    return path


def is_inside_notes_dir(path: str) -> bool:
    root = notes_root()
    path = os.path.abspath(path)
    return os.path.commonpath([root, path]) == root


def folder_from_path(path: str) -> str:
    """Folder of a file relative to the notes root ("" for top level)."""
    rel = os.path.relpath(os.path.dirname(os.path.abspath(path)), notes_root())
    return "" if rel == "." else sanitize_folder(rel.replace(os.sep, "/"))


def write_atomic(path: str, content: str):
    """
    Write via temp file + rename so a crash never leaves a half-written note.
    The temp name ends in .tmp, which the file watcher ignores.
    """
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".smartnotes-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


async def free_note_path(db, folder: str, title: str, note_id: str = None, current_path: str = None) -> str:
    """
    Pick SMARTNOTES_DIR/<folder>/<title>.md, adding " (n)" when another note or
    an untracked file already uses that name.
    """
    directory = folder_path(folder)
    base = sanitize_title(title)

    async def is_free(path: str) -> bool:
        async with db.execute("SELECT id FROM notes WHERE file_path = ?", (path,)) as cursor:
            row = await cursor.fetchone()
        if row:
            return row[0] == note_id
        if not os.path.exists(path):
            return True
        # Same file under a different case on case-insensitive filesystems
        return bool(current_path and os.path.exists(current_path) and os.path.samefile(path, current_path))

    candidate = os.path.join(directory, f"{base}.md")
    counter = 1
    while not await is_free(candidate):
        candidate = os.path.join(directory, f"{base} ({counter}).md")
        counter += 1
    return candidate
