"""
Auto-linker service — creates automatic links between semantically similar notes.
Spec: threshold 0.75, configurable. link_type = 'auto' vs 'manual' for wikilinks.
"""
import time
import asyncio
import logging
from backend.services.chromadb_store import get_all_embeddings_for_note, query_similar
from backend.db import get_db_connection, get_setting

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 0.75


async def get_autolink_threshold() -> float:
    try:
        value = float(await get_setting("autolink_threshold", str(DEFAULT_THRESHOLD)))
        return min(max(value, 0.3), 0.99)
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD


async def run_autolink(note_id: str, model: str, threshold: float = None):
    """
    After embedding a note, compare against all other notes.
    If cosine similarity > threshold, create an auto-link.

    ChromaDB uses cosine distance (0 = identical, 2 = opposite).
    Similarity = 1 - distance. So threshold 0.75 → distance < 0.25.
    """
    if threshold is None:
        threshold = await get_autolink_threshold()
    max_distance = 1.0 - threshold

    # Get embeddings for this note's chunks
    note_embeddings = await asyncio.to_thread(get_all_embeddings_for_note, note_id, model)
    if not note_embeddings:
        return

    # For each chunk, find similar chunks from OTHER notes
    similar_notes = set()
    for item in note_embeddings:
        if item["embedding"] is None:
            continue
        results = await asyncio.to_thread(
            query_similar,
            query_embedding=item["embedding"],
            model=model,
            k=20,
            exclude_note_id=note_id,
        )
        for r in results:
            if r["distance"] <= max_distance:
                similar_notes.add((r["note_id"], 1.0 - r["distance"]))  # (target_id, similarity)

    # Keep highest similarity per target note
    best_scores = {}
    for target_id, score in similar_notes:
        if target_id not in best_scores or score > best_scores[target_id]:
            best_scores[target_id] = score

    db = await get_db_connection()
    try:
        # Always clear old auto-links, even when nothing is similar any more
        await db.execute("DELETE FROM links WHERE source_id = ? AND link_type = 'auto'", (note_id,))

        if best_scores:
            # Ignore stale vectors of notes that no longer exist
            placeholders = ",".join("?" * len(best_scores))
            async with db.execute(f"SELECT id FROM notes WHERE id IN ({placeholders})", list(best_scores)) as cursor:
                existing = {row[0] for row in await cursor.fetchall()}
            now = int(time.time())
            for target_id, score in best_scores.items():
                if target_id in existing:
                    await db.execute(
                        "INSERT OR REPLACE INTO links (source_id, target_id, link_type, similarity_score, created_at) "
                        "VALUES (?, ?, 'auto', ?, ?)",
                        (note_id, target_id, score, now),
                    )
        await db.commit()
        logger.info(f"Auto-linked note {note_id} to {len(best_scores)} notes")
    finally:
        await db.close()
