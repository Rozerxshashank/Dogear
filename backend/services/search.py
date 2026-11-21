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


def _query_terms(query: str) -> list[str]:
    terms = [t for t in re.findall(r"\w+", query.lower()) if t not in _STOPWORDS and len(t) > 1]
    return list(dict.fromkeys(terms)) or re.findall(r"\w+", query.lower())


def _term_coverage(terms: list[str], text: str) -> float:
    """Share of query terms that appear in the text (prefix match, so "rise" matches "rising")."""
    if not terms:
        return 0.0
    words = set(re.findall(r"\w+", text.lower()))
    def hit(term: str) -> bool:
        stem = term[:max(4, len(term) - 2)]
        return any(w.startswith(stem) for w in words)
    return sum(hit(t) for t in terms) / len(terms)


KEYWORD_WEIGHT = 0.5
# A result must clear both bars to be shown: an absolute minimum (weaker matches are
# noise) and a share of the best match. Measured on backend/tests/fixtures/sample_notes.
MIN_RELEVANCE = 0.18
RELEVANCE_FLOOR = 0.2


def reciprocal_rank_fusion(vector_results: list, keyword_results: list, k: int = 60, query: str = "") -> list[dict]:
    """
    Merge semantic and keyword results into one score per note.

    - Semantic: the cosine similarity of the note's best-matching chunk. Using the
      similarity itself (not just its position) keeps a clear semantic winner on top.
      Each note counts once, so long notes with many chunks don't get extra votes.
    - Keyword: weighted by how much of the query the note covers and by BM25 order,
      so sharing one common word ("long") with the question adds little, while a note
      matching most of the words gets a real boost.
    """
    scores = {}  # note_id -> {score, note_id, text, title?}

    for item in vector_results:  # sorted by distance; first chunk per note is its best
        note_id = item["note_id"]
        if note_id not in scores:
            similarity = max(0.0, 1.0 - float(item.get("distance", 1.0)))
            scores[note_id] = {"score": similarity, "note_id": note_id, "text": item.get("text", "")}

    terms = _query_terms(query) if query else []
    for rank, item in enumerate(keyword_results):
        note_id = item["note_id"]
        coverage = _term_coverage(terms, f"{item.get('title', '')} {item.get('content', '')}") if terms else 1.0
        if note_id not in scores:
            # keep the full text so the snippet can centre on where the words matched
            scores[note_id] = {"score": 0.0, "note_id": note_id, "text": item.get("content", "")}
        scores[note_id]["score"] += KEYWORD_WEIGHT * coverage / (1 + 0.5 * rank)
        if item.get("title"):
            scores[note_id]["title"] = item["title"]

    return sorted(scores.values(), key=lambda x: x["score"], reverse=True)


async def hybrid_search(query: str, k: int = 10) -> list[dict]:
    """
    Run vector + keyword search concurrently, merge with RRF.
    Returns top-k results with note_id, title, text snippet, and score.
    """
    vector_task = vector_search(query, k=k * 2)
    keyword_task = keyword_search(query, k=k * 2)

    vector_results, keyword_results = await asyncio.gather(vector_task, keyword_task)

    merged = reciprocal_rank_fusion(vector_results, keyword_results, query=query)
    # Drop results far weaker than the best match, so a search doesn't list every note
    if merged:
        floor = max(MIN_RELEVANCE, merged[0]["score"] * RELEVANCE_FLOOR)
        merged = [m for i, m in enumerate(merged) if i == 0 or m["score"] >= floor]

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
            item["text"] = make_snippet(_strip_chunk_prefix(item.get("text", "")), row[0], query)
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


_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]")


def make_snippet(text: str, title: str = "", query: str = "", size: int = 200) -> str:
    """
    Plain-text preview for search results: drops a leading heading that repeats the
    title, strips Markdown syntax, and centres on the matched words when possible.
    """
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    if lines and lines[0].lstrip().startswith("#"):
        heading = lines[0].lstrip("# ").strip().lower()
        if title and heading.startswith(title.strip().lower()):
            lines = lines[1:]
    plain = "\n".join(lines)
    plain = _WIKILINK.sub(lambda m: m.group(2) or m.group(1), plain)
    plain = _MD_LINK.sub(r"\1", plain)
    plain = re.sub(r"^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)", "", plain, flags=re.M)
    plain = re.sub(r"```.*?```", " ", plain, flags=re.S)
    plain = re.sub(r"(\*\*|__|\*|_|`|~~)", "", plain)
    plain = re.sub(r"\s+", " ", plain).strip()
    if query and len(plain) > size:
        plain = _window_around_terms(plain, query, size)
    elif len(plain) > size:
        plain = plain[:size].rsplit(" ", 1)[0] + "…"
    return plain


def _window_around_terms(content: str, query: str, size: int) -> str:
    """For keyword-only hits: the part of the note around the first matching term."""
    lower = content.lower()
    positions = []
    for term in _query_terms(query):
        # match word stems, so "focused" finds "focus" and "rise" finds "rising"
        stem = term[:max(4, len(term) - 2)] if len(term) > 4 else term
        found = re.search(r"\b" + re.escape(stem), lower)
        if found:
            positions.append(found.start())
    if not positions or len(content) <= size:
        return content[:size]
    start = max(0, min(positions) - size // 4)
    if start:
        # Begin at a sentence start if one is close, otherwise at a word boundary
        sentence = max(content.rfind(". ", 0, start + 1), content.rfind("\n", 0, start + 1))
        if sentence != -1 and start - sentence < size // 3:
            start = sentence + 1
        else:
            space = content.rfind(" ", 0, start + 1)
            start = space + 1 if space != -1 else start
        while start < len(content) and content[start] in " \n":
            start += 1
    end = start + size
    if end < len(content):
        space = content.rfind(" ", start, end)
        end = space if space > start else end
    return ("…" if start else "") + content[start:end].strip() + ("…" if end < len(content) else "")


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
    ranked = reciprocal_rank_fusion(vector_results, keyword_results, query=query)

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
