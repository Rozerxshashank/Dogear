import os
import sys
import asyncio
import logging
import threading
import time

import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware

from backend.config import init_config, setup_logging, HOST, PORT
from backend.db import init_db, rebase_note_paths
from backend.routers import notes, sync, search, chat, graph, indexing, importer, system
from backend.services.pipeline import reindex_missing
from backend.services.reconcile import reconcile_notes_dir

logger = logging.getLogger(__name__)


async def _startup_maintenance():
    """Pick up changes made while the app was closed, then fill vector gaps."""
    try:
        await reconcile_notes_dir()
    except Exception:
        logger.exception("Startup reconcile failed")
    await reindex_missing()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_config()
    await init_db()
    # The app was renamed and the notes folder moved with it: update stored paths first
    previous_dir = os.environ.get("SMARTNOTES_PREVIOUS_DIR")
    if previous_dir:
        from backend import config
        moved = await rebase_note_paths(previous_dir, config.SMARTNOTES_DIR)
        logger.info(f"Notes folder moved from {previous_dir}: updated {moved} note paths")
    maintenance = asyncio.create_task(_startup_maintenance())
    yield
    maintenance.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

# Only the app's own renderer may call the API: the Vite dev server, or the
# packaged app loaded from file:// (which browsers report as "null").
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(http://localhost:5173|file://.*|null)$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-IPC-Token"],
)

IPC_TOKEN = os.environ.get("IPC_TOKEN")


async def verify_ipc_token(x_ipc_token: str = Header(None)):
    if not IPC_TOKEN:
        raise HTTPException(status_code=500, detail="IPC_TOKEN env var not set")
    if x_ipc_token != IPC_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden: Invalid IPC token")


@app.get("/health")
async def health_check():
    return {"status": "ok"}


# All real endpoints require the per-launch token
api_router = FastAPI(dependencies=[Depends(verify_ipc_token)], docs_url=None, redoc_url=None, openapi_url=None)
for r in (notes, sync, search, chat, graph, indexing, importer, system):
    api_router.include_router(r.router)
app.mount("/api", api_router)


def _exit_when_parent_dies():
    """If Electron crashes or is force-killed, don't leave an orphan backend running."""
    parent = os.environ.get("SMARTNOTES_PARENT_PID")
    if not parent:
        return

    pid = int(parent)

    def alive() -> bool:
        if sys.platform == "win32":
            # os.kill(pid, 0) would TERMINATE the process on Windows; query it instead
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            kernel32.CloseHandle(handle)
            return code.value == 259  # STILL_ACTIVE
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def watch():
        while True:
            time.sleep(2)
            if not alive():
                logger.info("Parent process gone; shutting down backend")
                os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def run():
    setup_logging()
    _exit_when_parent_dies()
    uvicorn.run(app, host=HOST, port=PORT, log_config=None)


if __name__ == "__main__":
    run()
    sys.exit(0)
