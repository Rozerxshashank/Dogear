"""
Embedder service — generates embeddings using Ollama, Mistral, or SBERT fallback.
Spec: Ollama nomic-embed-text → Mistral API → bundled all-MiniLM-L6-v2

Every call returns the id of the model that produced the vectors, so callers can
store and query them in that model's own vector collection. Vectors from
different models are never comparable.
"""
import os
import time
import asyncio
import logging
from typing import NamedTuple

logger = logging.getLogger(__name__)

OLLAMA_EMBED_MODEL = "nomic-embed-text"
SBERT_MODEL = "all-MiniLM-L6-v2"
MISTRAL_EMBED_MODEL = "mistral-embed"

MODEL_IDS = {
    "ollama": f"ollama:{OLLAMA_EMBED_MODEL}",
    "sbert": f"sbert:{SBERT_MODEL}",
    "mistral": f"mistral:{MISTRAL_EMBED_MODEL}",
}


OLLAMA_RETRY_S = 30.0
_ollama_retry_at = 0.0  # monotonic time before which Ollama is skipped


class Embeddings(NamedTuple):
    model: str                    # e.g. "ollama:nomic-embed-text"
    vectors: list[list[float]]


# Lazy-loaded CPU fallback: all-MiniLM-L6-v2 as ONNX (the same model and vectors
# as sentence-transformers, without bundling PyTorch). Packaged builds ship the
# model in SMARTNOTES_MODELS_DIR so no download is needed.
_sbert_model = None


def _get_sbert_model():
    global _sbert_model
    if _sbert_model is None:
        from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

        models_dir = os.environ.get("SMARTNOTES_MODELS_DIR")
        if models_dir:
            bundled = os.path.join(models_dir, SBERT_MODEL)
            if os.path.exists(os.path.join(bundled, "onnx", "model.onnx")):
                ONNXMiniLM_L6_V2.DOWNLOAD_PATH = bundled
        _sbert_model = ONNXMiniLM_L6_V2()
        logger.info(f"CPU embedding model loaded from {ONNXMiniLM_L6_V2.DOWNLOAD_PATH}")
    return _sbert_model


async def embed_texts(texts: list[str], provider: str = "auto") -> Embeddings:
    """
    Embed a list of texts using the configured provider.

    Args:
        texts: List of strings to embed
        provider: "ollama", "mistral", "sbert", or "auto" (Ollama, then SBERT)

    Returns:
        Embeddings(model, vectors). `model` identifies the vector space.
    """
    if provider == "auto":
        global _ollama_retry_at
        if time.monotonic() >= _ollama_retry_at:
            try:
                return await _embed_ollama(texts)
            except Exception as e:
                # Don't retry (or log) on every call while Ollama is down
                if _ollama_retry_at == 0.0:
                    logger.warning(f"Ollama embedding unavailable ({e}); using the built-in CPU model")
                _ollama_retry_at = time.monotonic() + OLLAMA_RETRY_S
        return await _embed_sbert(texts)
    elif provider == "ollama":
        return await _embed_ollama(texts)
    elif provider == "mistral":
        return await _embed_mistral(texts)
    elif provider == "sbert":
        return await _embed_sbert(texts)
    raise ValueError(f"Unknown embedding provider: {provider}")


async def _embed_ollama(texts: list[str]) -> Embeddings:
    """Embed using Ollama's nomic-embed-text model (non-blocking, batched)."""
    model_id = MODEL_IDS["ollama"]
    if not texts:
        return Embeddings(model_id, [])
    import ollama

    global _ollama_retry_at
    response = await ollama.AsyncClient().embed(model=OLLAMA_EMBED_MODEL, input=texts)
    _ollama_retry_at = 0.0
    return Embeddings(model_id, [list(v) for v in response["embeddings"]])


async def _embed_mistral(texts: list[str]) -> Embeddings:
    """Embed using Mistral's API."""
    model_id = MODEL_IDS["mistral"]
    if not texts:
        return Embeddings(model_id, [])
    import httpx

    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        raise ValueError("MISTRAL_API_KEY not set")

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            "https://api.mistral.ai/v1/embeddings",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": MISTRAL_EMBED_MODEL, "input": texts},
        )
        response.raise_for_status()
        data = response.json()
        return Embeddings(model_id, [item["embedding"] for item in data["data"]])


def _encode_sbert(texts: list[str]) -> list[list[float]]:
    model = _get_sbert_model()
    return [[float(x) for x in e] for e in model(texts)]


async def _embed_sbert(texts: list[str]) -> Embeddings:
    """Embed with all-MiniLM-L6-v2 on CPU (384-dim), off the event loop."""
    model_id = MODEL_IDS["sbert"]
    if not texts:
        return Embeddings(model_id, [])
    return Embeddings(model_id, await asyncio.to_thread(_encode_sbert, texts))
