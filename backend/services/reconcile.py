"""
Startup reconciliation: the file watcher only sees changes while the app is
running, so on launch compare the notes folder with the database and apply
whatever happened while it was closed (new, edited, moved and deleted files).
"""
import os
import time
import uuid
import logging

from backend.db import get_db_connection
from backend.services.files import compute_hash, folder_from_path, notes_root, read_text
from backend.services.pipeline import embed_note, delete_note_embeddings

logger = logging.getLogger(__name__)


def scan_markdown_files(root: str) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]  # .git, .obsidian, ...
        for name in filenames:
            if name.endswith(".md") and not name.startswith("."):
                found.append(os.path.abspath(os.path.join(dirpath, name)))
    return found


async def reconcile_notes_dir() -> dict:
    root = notes_root()
    if not os.path.isdir(root):
        # Folder missing (e.g. unmounted drive): never treat that as "delete everything"
        logger.warning(f"Notes folder {root} not found; skipping reconcile")
        return {"skipped": True}

    on_disk = {p: None for p in scan_markdown_files(root)}
    stats = {"created": 0, "updated": 0, "moved": 0, "deleted": 0}
    to_embed = []
    to_unembed = []

    db = await get_db_connection()
    try:
        async with db.execute("SELECT id, title, folder, file_path, content_hash FROM notes") as cursor:
            rows = [dict(r) for r in await cursor.fetchall()]

        missing = []
        for row in rows:
            path = row["file_path"]
            if path and path in on_disk:
                content = read_text(path)
                h = compute_hash(content)
                on_disk[path] = h
                if h != row["content_hash"]:
                    await db.execute(
                        "UPDATE notes SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?",
                        (content, h, int(time.time()), row["id"]),
                    )
                    to_embed.append((row["id"], row["title"], row["folder"] or "", content))
                    stats["updated"] += 1
                on_disk.pop(path)
            elif path:
                missing.append(row)

        # Remaining files are untracked: pair with missing rows by content (moved), else create
        by_hash = {}
        for path in list(on_disk):
            content = read_text(path)
            by_hash.setdefault(compute_hash(content), []).append((path, content))

        for row in missing:
            candidates = by_hash.get(row["content_hash"]) or []
            if candidates:
                path, content = candidates.pop(0)
                folder = folder_from_path(path)
                await db.execute(
                    "UPDATE notes SET file_path = ?, folder = ?, updated_at = ? WHERE id = ?",
                    (path, folder, int(time.time()), row["id"]),
                )
                to_embed.append((row["id"], row["title"], folder, content))
                stats["moved"] += 1
            else:
                await db.execute("DELETE FROM notes WHERE id = ?", (row["id"],))
                to_unembed.append(row["id"])
                stats["deleted"] += 1

        now = int(time.time())
        for h, items in by_hash.items():
            for path, content in items:
                note_id = str(uuid.uuid4())
                title = os.path.splitext(os.path.basename(path))[0]
                folder = folder_from_path(path)
                await db.execute(
                    "INSERT INTO notes (id, title, content, folder, created_at, updated_at, file_path, content_hash) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (note_id, title, content, folder, now, now, path, h),
                )
                to_embed.append((note_id, title, folder, content))
                stats["created"] += 1

        await db.commit()
    finally:
        await db.close()

    for note_id in to_unembed:
        await delete_note_embeddings(note_id)
    for args in to_embed:
        await embed_note(*args)

    if any(stats.values()):
        logger.info(f"Reconciled notes folder: {stats}")
    return stats
