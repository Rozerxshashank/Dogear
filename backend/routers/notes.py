from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel, Field
import uuid
import time
import os
import logging
from typing import List, Optional
from backend.db import get_db_connection
from backend.services.files import (
    compute_hash, sanitize_folder, free_note_path, write_atomic, is_inside_notes_dir, read_text,
)
from backend.services.pipeline import embed_note, delete_note_embeddings
from backend.services.links import sync_manual_links, relink_mentions_of

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notes", tags=["notes"])

MAX_TITLE = 200
MAX_CONTENT = 5_000_000  # 5 MB of text per note


# --- Schemas ---

class NoteBase(BaseModel):
    title: str = Field(..., title="Title of the note", max_length=MAX_TITLE)
    content: Optional[str] = Field("", max_length=MAX_CONTENT)
    folder: Optional[str] = Field("", max_length=500)


class NoteCreate(NoteBase):
    pass


class NoteUpdate(NoteBase):
    title: Optional[str] = Field(None, max_length=MAX_TITLE)
    content: Optional[str] = Field(None, max_length=MAX_CONTENT)
    folder: Optional[str] = Field(None, max_length=500)


class NoteResponse(NoteBase):
    id: str
    created_at: int
    updated_at: int
    file_path: Optional[str] = None
    content_hash: Optional[str] = None


# --- Dependencies ---

async def db_dep():
    db = await get_db_connection()
    try:
        yield db
    finally:
        await db.close()


async def _fetch(db, note_id: str) -> dict:
    async with db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Note not found")
    return dict(row)


# --- Endpoints ---

@router.post("/", response_model=NoteResponse)
async def create_note(note: NoteCreate, background_tasks: BackgroundTasks, db=Depends(db_dep)):
    note_id = str(uuid.uuid4())
    now = int(time.time())
    folder = sanitize_folder(note.folder or "")
    content = note.content or ""
    content_hash = compute_hash(content)
    file_path = await free_note_path(db, folder, note.title, note_id)

    # 1. DB first, so the file watcher recognises the file as ours when it appears
    await db.execute(
        "INSERT INTO notes (id, title, content, folder, created_at, updated_at, file_path, content_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (note_id, note.title, content, folder, now, now, file_path, content_hash),
    )
    await sync_manual_links(db, note_id, content)
    await relink_mentions_of(db, note.title)
    await db.commit()

    # 2. Disk
    try:
        write_atomic(file_path, content)
    except OSError as e:
        await db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        await db.commit()
        logger.error(f"Could not write {file_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Could not write note file: {e}") from e

    # 3. Background embed
    background_tasks.add_task(embed_note, note_id, note.title, folder, content)
    return await _fetch(db, note_id)


@router.get("/", response_model=List[NoteResponse])
async def list_notes(db=Depends(db_dep)):
    async with db.execute("SELECT * FROM notes ORDER BY updated_at DESC") as cursor:
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


@router.get("/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str, db=Depends(db_dep)):
    return await _fetch(db, note_id)


@router.put("/{note_id}", response_model=NoteResponse)
async def update_note(note_id: str, note_update: NoteUpdate, background_tasks: BackgroundTasks, db=Depends(db_dep)):
    existing = await _fetch(db, note_id)
    now = int(time.time())

    new_title = note_update.title if note_update.title is not None else existing["title"]
    new_content = note_update.content if note_update.content is not None else (existing["content"] or "")
    new_folder = sanitize_folder(note_update.folder) if note_update.folder is not None else (existing["folder"] or "")
    content_hash = compute_hash(new_content)

    old_path = existing.get("file_path")
    moved = new_title != existing["title"] or new_folder != (existing["folder"] or "") or not old_path
    new_path = (
        await free_note_path(db, new_folder, new_title, note_id, current_path=old_path)
        if moved else old_path
    )

    # 1. DB first
    await db.execute(
        "UPDATE notes SET title = ?, content = ?, folder = ?, updated_at = ?, file_path = ?, content_hash = ? WHERE id = ?",
        (new_title, new_content, new_folder, now, new_path, content_hash, note_id),
    )
    await sync_manual_links(db, note_id, new_content)
    if new_title != existing["title"]:
        await relink_mentions_of(db, new_title)
    await db.commit()

    # 2. Rename/move, then write
    try:
        if old_path and old_path != new_path and os.path.exists(old_path):
            os.makedirs(os.path.dirname(new_path), exist_ok=True)
            os.replace(old_path, new_path)
            _remove_empty_dirs(os.path.dirname(old_path))
        write_atomic(new_path, new_content)
    except OSError as e:
        logger.error(f"Could not write {new_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Could not write note file: {e}") from e

    # 3. Background embed (title/folder are part of every chunk, so re-embed on move too)
    background_tasks.add_task(embed_note, note_id, new_title, new_folder, new_content)
    return await _fetch(db, note_id)


@router.delete("/{note_id}")
async def delete_note(note_id: str, background_tasks: BackgroundTasks, db=Depends(db_dep)):
    existing = await _fetch(db, note_id)
    file_path = existing.get("file_path")

    await db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    await db.commit()

    if file_path and os.path.exists(file_path) and is_inside_notes_dir(file_path):
        os.remove(file_path)
        _remove_empty_dirs(os.path.dirname(file_path))

    background_tasks.add_task(delete_note_embeddings, note_id)
    return {"status": "deleted", "id": note_id}


@router.post("/{note_id}/reload-from-file", response_model=NoteResponse)
async def reload_from_file(note_id: str, background_tasks: BackgroundTasks, db=Depends(db_dep)):
    """Resolve a conflict in favour of the file on disk."""
    existing = await _fetch(db, note_id)
    path = existing.get("file_path")
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="The note's file no longer exists")
    content = read_text(path)
    await db.execute(
        "UPDATE notes SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?",
        (content, compute_hash(content), int(time.time()), note_id),
    )
    await sync_manual_links(db, note_id, content)
    await db.commit()
    background_tasks.add_task(embed_note, note_id, existing["title"], existing["folder"] or "", content)
    return await _fetch(db, note_id)


@router.get("/{note_id}/links")
async def get_note_links(note_id: str, db=Depends(db_dep)):
    query = """
        SELECT DISTINCT n.id, n.title
        FROM notes n
        JOIN links l ON (n.id = l.target_id OR n.id = l.source_id)
        WHERE (l.source_id = ? OR l.target_id = ?) AND n.id != ?
    """
    async with db.execute(query, (note_id, note_id, note_id)) as cursor:
        rows = await cursor.fetchall()
        return [{"id": row["id"], "title": row["title"]} for row in rows]


def _remove_empty_dirs(directory: str):
    """Remove now-empty folders up to (not including) the notes root."""
    from backend.services.files import notes_root
    root = notes_root()
    directory = os.path.abspath(directory)
    while directory != root and is_inside_notes_dir(directory):
        try:
            os.rmdir(directory)  # only succeeds when empty
        except OSError:
            return
        directory = os.path.dirname(directory)
