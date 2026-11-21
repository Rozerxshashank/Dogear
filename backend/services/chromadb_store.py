"""
ChromaDB Store — embedded vector store for semantic search.
Spec: Dual-index pattern — ChromaDB for vectors, SQLite for metadata.

Each embedding model gets its own collection. Vectors from different models
have different dimensions and live in different vector spaces, so they must
never be mixed in one collection (e.g. Ollama 768-dim vs SBERT 384-dim).
"""
import os
import re
import logging
import chromadb

from backend.config import CHROMA_DIR

logger = logging.getLogger(__name__)

_client = None
_collections: dict = {}

COLLECTION_PREFIX = "smartnotes__"



def _get_client():
    global _client
    if _client is None:
        os.makedirs(CHROMA_DIR, exist_ok=True)
        _client = chromadb.PersistentClient(path=CHROMA_DIR)
        logger.info(f"ChromaDB client initialized at {CHROMA_DIR}")
    return _client


def collection_name_for(model: str) -> str:
    """Map an embedding model id to a valid, stable Chroma collection name."""
    slug = re.sub(r"[^a-zA-Z0-9._-]", "-", model).strip("-._") or "default"
    return f"{COLLECTION_PREFIX}{slug}"


def get_collection(model: str):
    """Get or initialize the ChromaDB collection for an embedding model."""
    name = collection_name_for(model)
    if name not in _collections:
        _collections[name] = _get_client().get_or_create_collection(
            name=name,
            metadata={"hnsw:space": "cosine", "embedding_model": model},
        )
    return _collections[name]


def _all_model_collections():
    """Every per-model collection that exists on disk."""
    client = _get_client()
    result = []
    for c in client.list_collections():
        name = c if isinstance(c, str) else c.name
        if name.startswith(COLLECTION_PREFIX):
            if name not in _collections:
                _collections[name] = client.get_collection(name)
            result.append(_collections[name])
    return result


def upsert_chunks(chunks: list[dict], embeddings: list[list[float]], model: str):
    """Upsert note chunks into the collection for `model`."""
    if len(chunks) == 0 or len(embeddings) == 0:
        return

    collection = get_collection(model)
    collection.upsert(
        ids=[c["chunk_id"] for c in chunks],
        documents=[c["text"] for c in chunks],
        embeddings=embeddings,
        metadatas=[{"note_id": c["note_id"], "chunk_index": c["index"]} for c in chunks],
    )
    logger.info(f"Upserted {len(chunks)} chunks for note {chunks[0]['note_id']} ({model})")


def delete_note_chunks(note_id: str):
    """Remove all chunks for a note from every model's collection."""
    for collection in _all_model_collections():
        results = collection.get(where={"note_id": note_id})
        if results["ids"]:
            collection.delete(ids=results["ids"])
            logger.info(f"Deleted {len(results['ids'])} chunks for note {note_id} from {collection.name}")


def indexed_note_ids(model: str) -> set[str]:
    """Note ids that have at least one chunk in `model`'s collection."""
    results = get_collection(model).get(include=["metadatas"])
    return {m["note_id"] for m in (results["metadatas"] or []) if m and "note_id" in m}


def query_similar(query_embedding: list[float], model: str, k: int = 10, exclude_note_id: str = None) -> list[dict]:
    """
    Query `model`'s collection for similar chunks.

    Returns list of {chunk_id, note_id, text, distance, chunk_index}
    """
    collection = get_collection(model)
    if collection.count() == 0:
        return []

    where_filter = {"note_id": {"$ne": exclude_note_id}} if exclude_note_id else None

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=k,
        where=where_filter,
        include=["documents", "metadatas", "distances"],
    )

    items = []
    if results["ids"] and results["ids"][0]:
        for i, chunk_id in enumerate(results["ids"][0]):
            items.append({
                "chunk_id": chunk_id,
                "note_id": results["metadatas"][0][i]["note_id"],
                "text": results["documents"][0][i],
                "distance": results["distances"][0][i],
                "chunk_index": results["metadatas"][0][i]["chunk_index"],
            })
    return items


def get_all_embeddings_for_note(note_id: str, model: str) -> list[dict]:
    """Get all stored embeddings for a note in `model`'s collection (for auto-linking)."""
    results = get_collection(model).get(
        where={"note_id": note_id},
        include=["embeddings", "metadatas"],
    )

    items = []
    embeddings = results.get("embeddings")
    if results["ids"]:
        for i, chunk_id in enumerate(results["ids"]):
            items.append({
                "chunk_id": chunk_id,
                "embedding": embeddings[i] if embeddings is not None else None,
                "note_id": note_id,
            })
    return items
