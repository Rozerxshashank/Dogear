"""
Embedding pipeline — orchestrates chunking, embedding, ChromaDB upsert, and auto-linking.
Triggered as a BackgroundTask on every note save.
"""
import asyncio
import logging
from backend.services.chunker import chunk_note
from backend.services.embedder import embed_texts
from backend.services.chromadb_store import upsert_chunks, delete_note_chunks, indexed_note_ids
from backend.services.autolinker import run_autolink

logger = logging.getLogger(__name__)

# Track indexing status
_indexing_status = {
    "is_indexing": False,
    "current_note_id": None,
    "queue_size": 0,
    "completed": 0,
    "total": 0,
}
_in_flight = 0

# Serialize pipeline runs so two saves of the same note can't interleave
# their delete/upsert steps in the vector store.
_pipeline_lock = asyncio.Lock()


def get_indexing_status() -> dict:
    return dict(_indexing_status)


async def embed_note(note_id: str, title: str, folder: str, content: str):
    """
    Full embedding pipeline for a single note.
    Run as a FastAPI BackgroundTask. All blocking work runs off the event loop.
    """
    global _in_flight
    _in_flight += 1
    _indexing_status["is_indexing"] = True
    _indexing_status["queue_size"] = _in_flight

    try:
        async with _pipeline_lock:
            _indexing_status["current_note_id"] = note_id

            # 1. Chunk the note
            chunks = chunk_note(note_id, title, folder, content or "")

            # 2. Remove old chunks from every model's collection
            await asyncio.to_thread(delete_note_chunks, note_id)

            if not chunks:
                return

            # 3. Generate embeddings and store them in that model's collection
            result = await embed_texts([c["text"] for c in chunks])
            await asyncio.to_thread(upsert_chunks, chunks, result.vectors, result.model)

            # 4. Run auto-linking within the same vector space
            await run_autolink(note_id, result.model)

            _indexing_status["completed"] += 1
            logger.info(f"Embedded note {note_id}: {len(chunks)} chunks ({result.model})")

    except Exception as e:
        logger.error(f"Embedding failed for note {note_id}: {e}")
    finally:
        _in_flight -= 1
        _indexing_status["queue_size"] = _in_flight
        if _in_flight == 0:
            _indexing_status["is_indexing"] = False
            _indexing_status["current_note_id"] = None


async def reindex_missing():
    """
    Embed every note that has no vectors for the currently available embedding
    model. Covers notes indexed only by the fallback model during an Ollama
    outage, and vectors from older builds that used a single shared collection.
    """
    from backend.db import get_db_connection

    try:
        probe = await embed_texts(["probe"])
    except Exception as e:
        logger.warning(f"Skipping re-index, no embedding model available: {e}")
        return

    have = await asyncio.to_thread(indexed_note_ids, probe.model)

    db = await get_db_connection()
    try:
        async with db.execute("SELECT id, title, folder, content FROM notes") as cursor:
            rows = [tuple(r) for r in await cursor.fetchall()]
    finally:
        await db.close()

    missing = [r for r in rows if r[0] not in have and (r[3] or "").strip()]
    if not missing:
        return
    logger.info(f"Re-indexing {len(missing)} notes for {probe.model}")
    _indexing_status["total"] = len(missing)
    for note_id, title, folder, content in missing:
        await embed_note(note_id, title, folder or "", content or "")


async def delete_note_embeddings(note_id: str):
    """Remove all embeddings and auto-links for a deleted note."""
    try:
        await asyncio.to_thread(delete_note_chunks, note_id)
        from backend.db import get_db_connection
        db = await get_db_connection()
        try:
            await db.execute("DELETE FROM links WHERE source_id = ? OR target_id = ?", (note_id, note_id))
            await db.commit()
        finally:
            await db.close()
    except Exception as e:
        logger.error(f"Failed to delete embeddings for note {note_id}: {e}")
