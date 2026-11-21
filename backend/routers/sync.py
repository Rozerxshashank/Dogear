"""
File-watcher sync: applies changes made to the notes folder outside the app.
Electron's chokidar watcher posts every add/change/unlink of a .md file here.
"""
import os
import time
import uuid
import asyncio
import logging
from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel

from backend.db import get_db_connection
from backend.services.files import (
    compute_hash, folder_from_path, is_inside_notes_dir, read_text, sanitize_title,
)
from backend.services.pipeline import embed_note, delete_note_embeddings
from backend.services.links import sync_manual_links, relink_mentions_of

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["sync"])

# An unlink followed within this window by an add with the same content is a rename/move.
RENAME_WINDOW_S = float(os.environ.get("SMARTNOTES_RENAME_WINDOW_S", "2.0"))

# path -> {note_id, content_hash, timestamp}
_recent_unlinks: dict = {}
# Pending "really deleted?" checks, kept so they aren't garbage-collected (and for tests)
_pending_deletes: set = set()


async def _finalize_unlink(path: str, dirty_note_ids: list):
    """After the rename window, delete the note if its file was not re-added elsewhere."""
    await asyncio.sleep(RENAME_WINDOW_S)
    info = _recent_unlinks.pop(path, None)
    if info is None or os.path.exists(path):
        return  # consumed by a rename, or the file came back
    note_id = info["note_id"]
    if note_id in dirty_note_ids:
        logger.info(f"File for note {note_id} deleted externally but has unsaved edits; keeping note")
        return
    db = await get_db_connection()
    try:
        # Only delete if the note still points at the vanished path
        cursor = await db.execute("DELETE FROM notes WHERE id = ? AND file_path = ?", (note_id, path))
        await db.commit()
        deleted = cursor.rowcount > 0
    finally:
        await db.close()
    if deleted:
        await delete_note_embeddings(note_id)
        logger.info(f"Deleted note {note_id}: file removed outside the app")


async def handleFileSystemEvent(event: str, path: str, dirty_note_ids: list, db,
                                background_tasks: BackgroundTasks = None) -> dict:
    """
    Handle one file system event from the watcher.

    Returns dict with status, action and optional conflict flag.
    """
    if not path.endswith(".md"):
        return {"status": "ignored", "reason": "Not a markdown file"}
    path = os.path.abspath(path)
    if not is_inside_notes_dir(path):
        return {"status": "ignored", "reason": "Outside notes folder"}

    # --- UNLINK ---
    if event == "unlink":
        async with db.execute("SELECT id, content_hash FROM notes WHERE file_path = ?", (path,)) as cursor:
            row = await cursor.fetchone()
        if not row:
            return {"status": "ignored", "reason": "No matching note in DB"}
        _recent_unlinks[path] = {"note_id": row["id"], "content_hash": row["content_hash"], "timestamp": time.time()}
        task = asyncio.create_task(_finalize_unlink(path, list(dirty_note_ids)))
        _pending_deletes.add(task)
        task.add_done_callback(_pending_deletes.discard)
        return {"status": "processed", "action": "unlink_tracked", "note_id": row["id"]}

    # --- ADD / CHANGE ---
    if not os.path.exists(path):
        return {"status": "ignored", "reason": "File does not exist on disk"}

    content = read_text(path)
    current_hash = compute_hash(content)
    folder = folder_from_path(path)

    def queue_embed(note_id: str, title: str, note_folder: str):
        if background_tasks is not None:
            background_tasks.add_task(embed_note, note_id, title, note_folder or "", content)

    async with db.execute("SELECT id, title, folder, content_hash FROM notes WHERE file_path = ?", (path,)) as cursor:
        row = await cursor.fetchone()

    if row:
        if row["content_hash"] == current_hash:
            return {"status": "ignored", "reason": "Internal save"}
        note_id = row["id"]
        if note_id in dirty_note_ids:
            return {"status": "conflict", "action": "conflict_detected", "conflict": True, "note_id": note_id}
        await db.execute(
            "UPDATE notes SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?",
            (content, current_hash, int(time.time()), note_id),
        )
        await sync_manual_links(db, note_id, content)
        await db.commit()
        queue_embed(note_id, row["title"], row["folder"])
        return {"status": "processed", "action": "external_edit_applied", "note_id": note_id}

    # Unknown file: a rename/move if it matches a recent unlink by content
    now = time.time()
    matched = None
    for unlink_path, info in list(_recent_unlinks.items()):
        if now - info["timestamp"] > RENAME_WINDOW_S:
            continue  # its finalize task will handle deletion
        if info["content_hash"] == current_hash:
            matched = unlink_path
            break

    stem = os.path.splitext(os.path.basename(path))[0]

    if matched:
        info = _recent_unlinks.pop(matched)
        note_id = info["note_id"]
        async with db.execute("SELECT title FROM notes WHERE id = ?", (note_id,)) as cursor:
            existing = await cursor.fetchone()
        if existing is None:
            matched = None
        else:
            # Keep the user's title unless the filename itself was changed
            title = existing["title"]
            old_stem = os.path.splitext(os.path.basename(matched))[0]
            if stem != old_stem and sanitize_title(title) != stem:
                title = stem
            await db.execute(
                "UPDATE notes SET file_path = ?, folder = ?, title = ?, updated_at = ? WHERE id = ?",
                (path, folder, title, int(time.time()), note_id),
            )
            if title != existing["title"]:
                await relink_mentions_of(db, title)
            await db.commit()
            queue_embed(note_id, title, folder)
            return {"status": "processed", "action": "rename_detected", "note_id": note_id}

    # Truly new external file
    note_id = str(uuid.uuid4())
    now_ts = int(time.time())
    await db.execute(
        "INSERT INTO notes (id, title, content, folder, created_at, updated_at, file_path, content_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (note_id, stem, content, folder, now_ts, now_ts, path, current_hash),
    )
    await sync_manual_links(db, note_id, content)
    await relink_mentions_of(db, stem)
    await db.commit()
    queue_embed(note_id, stem, folder)
    return {"status": "processed", "action": "external_creation", "note_id": note_id}


async def db_dep():
    db = await get_db_connection()
    try:
        yield db
    finally:
        await db.close()


class FSEventRequest(BaseModel):
    event: str
    path: str
    dirty_note_ids: list[str] = []


@router.post("/fs-event")
async def fs_event(payload: FSEventRequest, background_tasks: BackgroundTasks, db=Depends(db_dep)):
    return await handleFileSystemEvent(payload.event, payload.path, payload.dirty_note_ids, db, background_tasks)
