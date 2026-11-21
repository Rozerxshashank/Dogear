"""
Hybrid search — combines vector search (ChromaDB) + keyword search (FTS5) via RRF.
"""
import re
import asyncio
import logging
from collections import defaultdict
from backend.services.chromadb_store import query_similar
from backend.services.embedder import embed_texts
from backend.db import get_db_connection

logger = logging.getLogger(__name__)


async def vector_search(query: str, k: int = 10) -> list[dict]:
    """Search via ChromaDB semantic similarity."""
    try:
        result = await embed_texts([query])
    except Exception as e:
        logger.warning(f"Vector search unavailable: {e}")
        return []
    if not result.vectors:
        return []

    # Query only the collection built by the same model as the query vector
    return await asyncio.to_thread(
        query_similar, query_embedding=result.vectors[0], model=result.model, k=k
    )


_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from",
    "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "should", "that", "the", "this",
    "to", "was", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
    "about", "tell", "there", "any", "have", "has", "we", "our",
}


def build_fts_query(query: str) -> str:
    """
    Turn free text into a safe FTS5 query that matches ANY meaningful term.
    (FTS5's default is AND, which makes natural-language questions miss.)
    """
    terms = [t for t in re.findall(r"\w+", query.lower()) if t not in _STOPWORDS and len(t) > 1]
    if not terms:
        terms = re.findall(r"\w+", query.lower())
    seen = list(dict.fromkeys(terms))[:16]
    return " OR ".join(f'"{t}"' for t in seen)


async def keyword_search(query: str, k: int = 10) -> list[dict]:
    """Search via SQLite FTS5 keyword match."""
    fts_query = build_fts_query(query)
    if not fts_query:
        return []

    db = await get_db_connection()
    try:
        # FTS5 match query
        async with db.execute(
            """
            SELECT notes.id, notes.title, notes.content, notes.folder,
                   bm25(notes_fts) as rank
            FROM notes_fts
            JOIN notes ON notes.id = notes_fts.id
            WHERE notes_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, k)
        ) as cursor:
            rows = await cursor.fetchall()
            return [
                {
                    "note_id": row[0],
                    "title": row[1],
                    "content": row[2],
                    "folder": row[3],
                    "rank": row[4],
                }
                for row in rows
            ]
    finally:
        await db.close()


def reciprocal_rank_fusion(vector_results: list, keyword_results: list, k: int = 60) -> list[dict]:
    """
    Merge vector and keyword results using Reciprocal Rank Fusion.
    RRF score = sum(1 / (k + rank)) across result lists.
    """
    scores = {}  # note_id -> {score, data}

    # Score vector results
    for rank, item in enumerate(vector_results):
        note_id = item["note_id"]
        rrf_score = 1.0 / (k + rank + 1)
        if note_id not in scores:
            scores[note_id] = {"score": 0, "note_id": note_id, "text": item.get("text", "")}
        scores[note_id]["score"] += rrf_score

    # Score keyword results
    for rank, item in enumerate(keyword_results):
        note_id = item["note_id"]
        rrf_score = 1.0 / (k + rank + 1)
        if note_id not in scores:
            scores[note_id] = {
                "score": 0,
                "note_id": note_id,
                "text": item.get("content", "")[:500],
                "title": item.get("title", ""),
            }
        scores[note_id]["score"] += rrf_score
        # Prefer keyword result's title if available
        if "title" in item:
            scores[note_id]["title"] = item["title"]

    # Sort by RRF score descending
    ranked = sorted(scores.values(), key=lambda x: x["score"], reverse=True)
    return ranked


async def hybrid_search(query: str, k: int = 10) -> list[dict]:
    """
    Run vector + keyword search concurrently, merge with RRF.
    Returns top-k results with note_id, title, text snippet, and score.
    """
    vector_task = vector_search(query, k=k * 2)
    keyword_task = keyword_search(query, k=k * 2)

    vector_results, keyword_results = await asyncio.gather(vector_task, keyword_task)

    merged = reciprocal_rank_fusion(vector_results, keyword_results)

    # Enrich with titles and drop vectors whose note no longer exists
    results = []
    db = await get_db_connection()
    try:
        for item in merged:
            async with db.execute("SELECT title FROM notes WHERE id = ?", (item["note_id"],)) as cursor:
                row = await cursor.fetchone()
            if not row:
                continue
            item["title"] = row[0]
            item["text"] = _strip_chunk_prefix(item.get("text", ""))
            results.append(item)
            if len(results) >= k:
                break
    finally:
        await db.close()

    return results


def _strip_chunk_prefix(text: str) -> str:
    """Chunks are stored as "Title: X > folder\n\n<body>"; return the body."""
    if text.startswith("Title: ") and "\n\n" in text:
        return text.split("\n\n", 1)[1]
    return text


def _window_around_terms(content: str, query: str, size: int) -> str:
    """For keyword-only hits: the part of the note around the first matching term."""
    lower = content.lower()
    positions = [lower.find(t) for t in re.findall(r"\w+", query.lower()) if t not in _STOPWORDS and len(t) > 2]
    positions = [p for p in positions if p >= 0]
    if not positions or len(content) <= size:
        return content[:size]
    start = max(0, min(positions) - size // 4)
    return ("…" if start else "") + content[start:start + size]


async def retrieve_context(query: str, k_notes: int = 5, per_note_chars: int = 2500,
                           total_chars: int = 10000) -> list[dict]:
    """
    Retrieval for chat: the top notes by hybrid ranking, each represented by the
    passages that actually matched (not just the start of the note).

    Returns [{note_id, title, text}] in rank order.
    """
    vector_results, keyword_results = await asyncio.gather(
        vector_search(query, k=k_notes * 4), keyword_search(query, k=k_notes * 2)
    )
    ranked = reciprocal_rank_fusion(vector_results, keyword_results)

    chunks_by_note = defaultdict(dict)  # note_id -> {chunk_index: (distance, text)}
    for item in vector_results:
        chunks_by_note[item["note_id"]][item["chunk_index"]] = (item["distance"], _strip_chunk_prefix(item["text"]))

    context, used = [], 0
    db = await get_db_connection()
    try:
        for item in ranked:
            if len(context) >= k_notes or used >= total_chars:
                break
            async with db.execute("SELECT title, content FROM notes WHERE id = ?", (item["note_id"],)) as cursor:
                row = await cursor.fetchone()
            if not row:
                continue
            title, content = row[0], row[1] or ""
            budget = min(per_note_chars, total_chars - used)
            chunks = chunks_by_note.get(item["note_id"])
            if len(content) <= budget:
                text = content  # short note: send it whole
            elif chunks:
                # Most relevant passages first until the budget is used, then in reading order
                picked, size = [], 0
                for index, (_, chunk_text) in sorted(chunks.items(), key=lambda kv: kv[1][0]):
                    if picked and size + len(chunk_text) > budget:
                        break
                    picked.append(index)
                    size += len(chunk_text)
                text = "\n…\n".join(chunks[i][1] for i in sorted(picked))[:budget]
            else:
                text = _window_around_terms(content, query, budget)
            context.append({"note_id": item["note_id"], "title": title, "text": text})
            used += len(text)
    finally:
        await db.close()
    return context
