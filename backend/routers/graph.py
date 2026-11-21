from fastapi import APIRouter, Depends
from backend.db import get_db_connection

router = APIRouter(prefix="/graph", tags=["graph"])


async def db_dep():
    db = await get_db_connection()
    try:
        yield db
    finally:
        await db.close()


@router.get("/")
async def get_graph(db=Depends(db_dep)):
    """
    Return nodes and edges for the knowledge graph.
    Nodes = notes, edges = links (both manual and auto).
    Node size = word count, edge value = similarity score.
    """
    nodes = []
    async with db.execute("SELECT id, title, content FROM notes") as cursor:
        rows = await cursor.fetchall()
        for row in rows:
            word_count = len((row[2] or "").split()) if row[2] else 0
            nodes.append({
                "id": row[0],
                "label": row[1] or "Untitled",
                "val": max(1, word_count // 10),  # Scale down for rendering
            })

    # One edge per pair of notes. A typed [[link]] wins over an automatic one.
    edges_by_pair = {}
    async with db.execute("SELECT source_id, target_id, link_type, similarity_score FROM links") as cursor:
        for source, target, link_type, score in await cursor.fetchall():
            key = tuple(sorted((source, target)))
            current = edges_by_pair.get(key)
            if current is None or (link_type == "manual" and current["link_type"] != "manual") or \
                    (link_type == current["link_type"] and (score or 0) > current["value"]):
                edges_by_pair[key] = {"source": source, "target": target, "link_type": link_type, "value": score or 0.5}
    edges = list(edges_by_pair.values())

    return {"nodes": nodes, "edges": edges}
