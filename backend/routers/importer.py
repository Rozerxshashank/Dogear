"""
Importer router — import Obsidian / plain markdown folders.
Copies files into the notes folder keeping their sub-folder structure, turns
[[wikilinks]] into manual links, and queues background embedding.
"""
import os
import re
import uuid
import time
import logging
from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from pydantic import BaseModel

from backend.db import get_db_connection
from backend.services.files import (
    compute_hash, free_note_path, notes_root, read_text, sanitize_folder, write_atomic,
)
from backend.services.pipeline import embed_note

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import", tags=["import"])

MAX_IMPORT_FILE_BYTES = 5_000_000


class ImportRequest(BaseModel):
    folder_path: str


async def db_dep():
    db = await get_db_connection()
    try:
        yield db
    finally:
        await db.close()


def extract_wikilinks(content: str) -> list[str]:
    """Extract [[Target]], [[Target|alias]] and [[Target#heading]] targets."""
    targets = []
    for raw in re.findall(r"\[\[([^\]]+)\]\]", content):
        target = raw.split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            targets.append(target)
    return targets


@router.post("/folder")
async def import_folder(req: ImportRequest, background_tasks: BackgroundTasks, db=Depends(db_dep)):
    source = os.path.abspath(os.path.expanduser(req.folder_path))
    if not os.path.isdir(source):
        raise HTTPException(status_code=400, detail="Folder not found")
    root = notes_root()
    try:
        overlaps = os.path.commonpath([source, root]) in (source, root)
    except ValueError:  # different drives on Windows
        overlaps = False
    if overlaps:
        raise HTTPException(status_code=400, detail="Choose a folder outside your SmartNotes folder")

    imported, skipped = [], []

    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]  # skip .obsidian, .git, .trash
        rel = os.path.relpath(dirpath, source)
        folder = "" if rel == "." else sanitize_folder(rel.replace(os.sep, "/"))

        for filename in sorted(filenames):
            if not filename.endswith(".md") or filename.startswith("."):
                continue
            src = os.path.join(dirpath, filename)
            try:
                if os.path.getsize(src) > MAX_IMPORT_FILE_BYTES:
                    skipped.append({"file": src, "reason": "too large"})
                    continue
                content = read_text(src)
            except OSError as e:
                skipped.append({"file": src, "reason": str(e)})
                continue

            title = os.path.splitext(filename)[0]
            note_id = str(uuid.uuid4())
            now = int(time.time())
            dest = await free_note_path(db, folder, title, note_id)

            # DB row first (committed) so the watcher sees the new file as ours
            await db.execute(
                "INSERT INTO notes (id, title, content, folder, created_at, updated_at, file_path, content_hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (note_id, title, content, folder, now, now, dest, compute_hash(content)),
            )
            await db.commit()
            try:
                write_atomic(dest, content)
            except OSError as e:
                await db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
                await db.commit()
                skipped.append({"file": src, "reason": str(e)})
                continue

            imported.append({"id": note_id, "title": title, "folder": folder, "content": content})
            background_tasks.add_task(embed_note, note_id, title, folder, content)

    # Wikilinks -> manual links (titles are matched case-insensitively, like Obsidian)
    async with db.execute("SELECT id, title FROM notes") as cursor:
        by_title = {}
        for row in await cursor.fetchall():
            by_title.setdefault(row["title"].lower(), row["id"])
    now = int(time.time())
    for item in imported:
        for target in extract_wikilinks(item["content"]):
            target_id = by_title.get(os.path.basename(target).lower())
            if target_id and target_id != item["id"]:
                await db.execute(
                    "INSERT OR IGNORE INTO links (source_id, target_id, link_type, similarity_score, created_at) "
                    "VALUES (?, ?, 'manual', 1.0, ?)",
                    (item["id"], target_id, now),
                )
    await db.commit()

    logger.info(f"Imported {len(imported)} notes from {source} ({len(skipped)} skipped)")
    return {
        "count": len(imported),
        "notes": [{k: v for k, v in i.items() if k != "content"} for i in imported],
        "skipped": skipped,
    }
