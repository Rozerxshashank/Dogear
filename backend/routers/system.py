"""System endpoints: AI availability for the status dot, and backend-side settings."""
import asyncio
import logging
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel, Field

from backend.db import get_db_connection, set_setting
from backend.services.autolinker import get_autolink_threshold, run_autolink
from backend.services.chromadb_store import indexed_note_ids
from backend.services.embedder import MODEL_IDS, embed_texts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/status")
async def status():
    """Is local Ollama reachable, and does it have the models SmartNotes uses?"""
    ollama_state, models = "stopped", []
    try:
        import ollama
        listing = await asyncio.wait_for(ollama.AsyncClient().list(), timeout=3)
        models = [m.model for m in listing.models]
        ollama_state = "running"
    except Exception:
        pass

    def has(name: str) -> bool:
        return any(m == name or m.startswith(f"{name}:") for m in models)

    return {
        "ollama": ollama_state,
        "chat_model_ready": has("llama3.2"),
        "embed_model_ready": has("nomic-embed-text"),
        "embedding_model": MODEL_IDS["ollama"] if has("nomic-embed-text") else MODEL_IDS["sbert"],
    }


class Settings(BaseModel):
    autolink_threshold: float = Field(..., ge=0.3, le=0.99)


@router.get("/settings")
async def get_settings():
    return {"autolink_threshold": await get_autolink_threshold()}


async def _relink_all():
    try:
        model = (await embed_texts(["probe"])).model
    except Exception as e:
        logger.warning(f"Relink skipped: {e}")
        return
    note_ids = await asyncio.to_thread(indexed_note_ids, model)
    db = await get_db_connection()
    try:
        async with db.execute("SELECT id FROM notes") as cursor:
            existing = {r[0] for r in await cursor.fetchall()}
    finally:
        await db.close()
    for note_id in note_ids & existing:
        await run_autolink(note_id, model)
    logger.info(f"Re-linked {len(note_ids & existing)} notes")


@router.put("/settings")
async def put_settings(settings: Settings, background_tasks: BackgroundTasks):
    old = await get_autolink_threshold()
    await set_setting("autolink_threshold", str(settings.autolink_threshold))
    if abs(old - settings.autolink_threshold) > 1e-9:
        background_tasks.add_task(_relink_all)
    return {"autolink_threshold": settings.autolink_threshold}
