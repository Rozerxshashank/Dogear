"""
Test environment: every test session gets throwaway notes/data folders so
tests never touch the user's real notes or ~/.smartnotes.
Environment must be set before any backend module is imported.
"""
import os
import tempfile

_ROOT = tempfile.mkdtemp(prefix="smartnotes-test-")
os.environ["SMARTNOTES_DIR"] = os.path.join(_ROOT, "notes")
os.environ["SMARTNOTES_DATA_DIR"] = os.path.join(_ROOT, "data")
os.environ["SMARTNOTES_DB_PATH"] = os.path.join(_ROOT, "data", "test.db")
os.environ["SMARTNOTES_CHROMA_DIR"] = os.path.join(_ROOT, "data", "chromadb")
os.environ["SMARTNOTES_RENAME_WINDOW_S"] = "0.2"
os.environ["IPC_TOKEN"] = "test-token-123"
_models = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "resources", "models"))
if os.path.isdir(_models):
    os.environ.setdefault("SMARTNOTES_MODELS_DIR", _models)

import pytest_asyncio  # noqa: E402
from httpx import AsyncClient, ASGITransport  # noqa: E402

from backend.config import init_config  # noqa: E402
from backend.db import init_db  # noqa: E402

HEADERS = {"X-IPC-Token": "test-token-123"}


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    init_config()
    await init_db()
    yield


@pytest_asyncio.fixture
async def api():
    from backend.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers=HEADERS) as ac:
        yield ac
