"""
Chat router — SSE streaming RAG endpoint.
Spec: GET /api/ask/stream, grounded answers from notes only, with citations.
"""
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import AsyncIterator, List, Literal, Optional
from backend.services.search import retrieve_context
import os
import json
import logging
import httpx

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ask", tags=["chat"])

SYSTEM_PROMPT = """You are Dogear, a helpful assistant that answers questions based ONLY on the user's notes.

RULES:
1. ONLY use information from the provided note excerpts below. Do NOT use your general knowledge.
2. For every claim you make, cite the source note using the format [Note: Title].
3. If the answer cannot be found in the provided notes, say "I couldn't find information about that in your notes." Do NOT hallucinate or make up answers.
4. Be concise but thorough.

USER'S NOTES:
{context}
"""


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., max_length=100_000)

class ChatRequest(BaseModel):
    messages: List[Message] = Field(..., max_length=200)
    provider: Optional[str] = "ollama"
    api_key: Optional[str] = None

PROVIDER_LABELS = {"ollama": "Ollama", "gemini": "Gemini", "openai": "OpenAI", "mistral": "Mistral"}

# Model ids can be overridden without code changes.
OLLAMA_CHAT_MODEL = os.environ.get("SMARTNOTES_OLLAMA_MODEL", "llama3.2")
GEMINI_CHAT_MODEL = os.environ.get("SMARTNOTES_GEMINI_MODEL", "gemini-2.5-flash")
OPENAI_CHAT_MODEL = os.environ.get("SMARTNOTES_OPENAI_MODEL", "gpt-4o-mini")
MISTRAL_CHAT_MODEL = os.environ.get("SMARTNOTES_MISTRAL_MODEL", "mistral-small-latest")

# Both APIs speak the OpenAI chat-completions streaming protocol.
OPENAI_COMPATIBLE = {
    "openai": ("https://api.openai.com/v1/chat/completions", OPENAI_CHAT_MODEL),
    "mistral": ("https://api.mistral.ai/v1/chat/completions", MISTRAL_CHAT_MODEL),
}


class ProviderHTTPError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


async def _stream_provider(provider: str, api_key: Optional[str], system_message: str,
                           history: List[Message]) -> AsyncIterator[str]:
    """Yield text tokens from the selected chat provider."""
    chat_messages = [{"role": "system", "content": system_message}] + [
        {"role": m.role, "content": m.content} for m in history
    ]

    if provider == "gemini":
        if not api_key:
            raise ValueError("Gemini API key is required but not provided in settings.")
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        contents = [
            {"role": "user" if m.role == "user" else "model", "parts": [{"text": m.content}]}
            for m in history
        ]
        stream = await client.aio.models.generate_content_stream(
            model=GEMINI_CHAT_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(system_instruction=system_message),
        )
        async for chunk in stream:
            yield chunk.text or ""

    elif provider in OPENAI_COMPATIBLE:
        if not api_key:
            raise ValueError(f"{PROVIDER_LABELS[provider]} API key is required but not provided in settings.")
        url, model = OPENAI_COMPATIBLE[provider]
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=120.0)) as client:
            async with client.stream(
                "POST", url,
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "messages": chat_messages, "stream": True},
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode("utf-8", "replace")
                    raise ProviderHTTPError(response.status_code, body)
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        choices = json.loads(data).get("choices") or []
                    except json.JSONDecodeError:
                        continue
                    if choices:
                        yield (choices[0].get("delta") or {}).get("content") or ""

    else:
        # "ollama" and the embeddings-only "sbert" option both chat via local Ollama
        import ollama

        stream = await ollama.AsyncClient().chat(
            model=OLLAMA_CHAT_MODEL, messages=chat_messages, stream=True
        )
        async for chunk in stream:
            yield chunk["message"]["content"]


def _friendly_error(provider: str, e: Exception) -> str:
    label = PROVIDER_LABELS.get(provider, provider)
    status = getattr(e, "status", None) or getattr(e, "code", None) or getattr(e, "status_code", None)
    text = str(e)
    if status == 429 or "429" in text or "RESOURCE_EXHAUSTED" in text:
        return f"Error: {label} rate limit or quota exceeded. Please wait a moment and try again."
    if status in (401, 403) or "API key not valid" in text or "invalid_api_key" in text:
        return f"Error: Invalid {label} API key. Please check it in Settings."
    return f"Error from AI provider ({label}): {text}"


async def _generate_stream(messages: List[Message], provider: str = "ollama", api_key: str = None):
    """
    RAG pipeline:
    1. Hybrid search for relevant chunks using the latest user message
    2. Build context from top results
    3. Stream response from Ollama using conversation history
    """
    if not messages:
        return

    # Retrieval query: the latest question, plus the previous user turn so
    # follow-ups like "what about the second one?" still find the right notes.
    user_turns = [m.content for m in messages if m.role == "user"]
    retrieval_query = " ".join(user_turns[-2:]) if user_turns else messages[-1].content

    # 1. Retrieve the passages that matched
    results = await retrieve_context(retrieval_query, k_notes=5)

    if not results:
        msg = "I couldn't find any relevant notes to answer your question."
        yield f"data: {json.dumps({'type': 'token', 'content': msg})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'sources': []})}\n\n"
        return

    # 2. Build context
    sources = [{"id": r["note_id"], "title": r["title"]} for r in results]
    context_parts = [f"--- Note: {r['title']} ---\n{r['text']}\n" for r in results]
    context = "\n".join(context_parts)
    system_message = SYSTEM_PROMPT.format(context=context)

    # Limit conversation history to last 10 messages to avoid lag and token limits
    history_to_send = messages[-10:] if len(messages) > 10 else messages

    # 3. Stream from AI provider (all clients are async so the event loop stays free)
    try:
        async for token in _stream_provider(provider, api_key, system_message, history_to_send):
            if token:
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
    except Exception as e:
        logger.error(f"AI streaming error ({provider}): {e}")
        yield f"data: {json.dumps({'type': 'token', 'content': _friendly_error(provider, e)})}\n\n"

    # Final event with sources
    yield f"data: {json.dumps({'type': 'done', 'sources': sources})}\n\n"


@router.post("/stream")
async def ask_stream(request_data: ChatRequest, request: Request):
    """
    SSE streaming endpoint for RAG chat.
    Client consumes via EventSource API (using fetch POST).
    """
    async def event_generator():
        async for event in _generate_stream(request_data.messages, request_data.provider, request_data.api_key):
            # Check if client disconnected
            if await request.is_disconnected():
                logger.info("Client disconnected, stopping stream")
                break
            yield event

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
