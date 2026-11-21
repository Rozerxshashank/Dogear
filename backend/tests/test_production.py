"""Tests for folders, external file changes, reconcile, import, retrieval and chat providers."""
import asyncio
import json
import os

import httpx
import pytest

from backend import config
from backend.routers import chat, sync
from backend.services import search
from backend.services.files import sanitize_folder, sanitize_title
from backend.services.reconcile import reconcile_notes_dir

pytestmark = pytest.mark.asyncio


def notes_dir(*parts):
    return os.path.join(config.SMARTNOTES_DIR, *parts)


async def wait_for_pending_deletes():
    await asyncio.sleep(0)
    if sync._pending_deletes:
        await asyncio.gather(*list(sync._pending_deletes))


# --- sanitising ---------------------------------------------------------------

async def test_sanitize_folder_blocks_traversal_and_hidden_dirs():
    assert sanitize_folder("../../etc") == "etc"
    assert sanitize_folder("Work\\\\Projects/./.git/x") == "Work/Projects/x"
    assert sanitize_folder("") == ""
    assert sanitize_title("con") == "_con"
    assert sanitize_title("a/b:c") == "abc"
    assert sanitize_title("   ") == "Untitled"


# --- folders ------------------------------------------------------------------

async def test_note_in_folder_is_written_to_subfolder(api):
    res = await api.post("/api/notes/", json={"title": "Plan", "content": "x", "folder": "Work/Projects"})
    assert res.status_code == 200
    note = res.json()
    assert note["folder"] == "Work/Projects"
    assert note["file_path"] == notes_dir("Work", "Projects", "Plan.md")
    assert os.path.exists(note["file_path"])


async def test_folder_traversal_is_neutralised(api):
    res = await api.post("/api/notes/", json={"title": "Escape", "content": "x", "folder": "../../outside"})
    path = res.json()["file_path"]
    assert path.startswith(os.path.abspath(config.SMARTNOTES_DIR) + os.sep)


async def test_move_note_between_folders_moves_file_and_cleans_up(api):
    note = (await api.post("/api/notes/", json={"title": "Mover", "content": "body", "folder": "Old"})).json()
    moved = (await api.put(f"/api/notes/{note['id']}", json={"folder": "New/Place"})).json()
    assert moved["file_path"] == notes_dir("New", "Place", "Mover.md")
    assert os.path.exists(moved["file_path"])
    assert not os.path.exists(note["file_path"])
    assert not os.path.exists(notes_dir("Old"))  # empty folder removed


# --- changes made outside the app ---------------------------------------------

async def test_file_deleted_outside_app_deletes_note(api):
    note = (await api.post("/api/notes/", json={"title": "Doomed", "content": "bye"})).json()
    os.remove(note["file_path"])
    res = await api.post("/api/sync/fs-event", json={"event": "unlink", "path": note["file_path"]})
    assert res.json()["action"] == "unlink_tracked"
    await wait_for_pending_deletes()
    assert (await api.get(f"/api/notes/{note['id']}")).status_code == 404


async def test_deleted_file_of_dirty_note_keeps_note(api):
    note = (await api.post("/api/notes/", json={"title": "Editing", "content": "draft"})).json()
    os.remove(note["file_path"])
    await api.post("/api/sync/fs-event", json={"event": "unlink", "path": note["file_path"], "dirty_note_ids": [note["id"]]})
    await wait_for_pending_deletes()
    assert (await api.get(f"/api/notes/{note['id']}")).status_code == 200


async def test_file_moved_outside_app_keeps_note_identity(api):
    note = (await api.post("/api/notes/", json={"title": "Wanderer", "content": "same body"})).json()
    new_path = notes_dir("Archive", "Wanderer.md")
    os.makedirs(os.path.dirname(new_path), exist_ok=True)
    os.replace(note["file_path"], new_path)
    await api.post("/api/sync/fs-event", json={"event": "unlink", "path": note["file_path"]})
    res = await api.post("/api/sync/fs-event", json={"event": "add", "path": new_path})
    assert res.json()["action"] == "rename_detected"
    await wait_for_pending_deletes()
    fetched = (await api.get(f"/api/notes/{note['id']}")).json()
    assert fetched["file_path"] == new_path
    assert fetched["folder"] == "Archive"


async def test_new_file_in_subfolder_gets_folder(api):
    path = notes_dir("Inbox", "Dropped.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("# Dropped in")
    res = (await api.post("/api/sync/fs-event", json={"event": "add", "path": path})).json()
    assert res["action"] == "external_creation"
    note = (await api.get(f"/api/notes/{res['note_id']}")).json()
    assert note["folder"] == "Inbox" and note["title"] == "Dropped"


async def test_events_outside_notes_dir_are_ignored(api, tmp_path):
    outside = tmp_path / "evil.md"
    outside.write_text("x")
    res = await api.post("/api/sync/fs-event", json={"event": "add", "path": str(outside)})
    assert res.json()["status"] == "ignored"


async def test_reload_from_file_resolves_conflict_with_file_version(api):
    note = (await api.post("/api/notes/", json={"title": "Conflicted", "content": "mine"})).json()
    with open(note["file_path"], "w") as f:
        f.write("theirs")
    res = await api.post(f"/api/notes/{note['id']}/reload-from-file")
    assert res.status_code == 200 and res.json()["content"] == "theirs"


# --- startup reconcile ----------------------------------------------------------

async def test_reconcile_applies_changes_made_while_closed(api):
    kept = (await api.post("/api/notes/", json={"title": "Kept", "content": "v1"})).json()
    gone = (await api.post("/api/notes/", json={"title": "Gone", "content": "bye"})).json()

    with open(kept["file_path"], "w") as f:
        f.write("v2 edited while closed")
    os.remove(gone["file_path"])
    new_path = notes_dir("Offline", "Fresh.md")
    os.makedirs(os.path.dirname(new_path), exist_ok=True)
    with open(new_path, "w") as f:
        f.write("created while closed")

    stats = await reconcile_notes_dir()
    assert stats["updated"] >= 1 and stats["deleted"] >= 1 and stats["created"] >= 1

    assert (await api.get(f"/api/notes/{kept['id']}")).json()["content"] == "v2 edited while closed"
    assert (await api.get(f"/api/notes/{gone['id']}")).status_code == 404
    titles = {n["title"]: n for n in (await api.get("/api/notes/")).json()}
    assert titles["Fresh"]["folder"] == "Offline"


# --- import ---------------------------------------------------------------------

async def test_import_keeps_folders_and_wikilinks(api, tmp_path):
    vault = tmp_path / "vault"
    (vault / "Areas" / "Health").mkdir(parents=True)
    (vault / ".obsidian").mkdir()
    (vault / ".obsidian" / "ignored.md").write_text("config")
    (vault / "Index.md").write_text("See [[Sleep|my sleep notes]] and [[Missing]]")
    (vault / "Areas" / "Health" / "Sleep.md").write_text("Sleep 8 hours")

    res = await api.post("/api/import/folder", json={"folder_path": str(vault)})
    assert res.status_code == 200
    data = res.json()
    assert data["count"] == 2
    by_title = {n["title"]: n for n in data["notes"]}
    assert by_title["Sleep"]["folder"] == "Areas/Health"
    assert os.path.exists(notes_dir("Areas", "Health", "Sleep.md"))

    links = (await api.get(f"/api/notes/{by_title['Index']['id']}/links")).json()
    assert any(link["id"] == by_title["Sleep"]["id"] for link in links)


async def test_import_rejects_the_notes_folder_itself(api):
    res = await api.post("/api/import/folder", json={"folder_path": config.SMARTNOTES_DIR})
    assert res.status_code == 400


# --- search and retrieval -------------------------------------------------------

async def test_fts_query_matches_any_meaningful_term():
    q = search.build_fts_query('What did I write about "quantum" computing?')
    assert q == '"write" OR "quantum" OR "computing"'
    assert search.build_fts_query("!!!") == ""


async def test_keyword_search_finds_natural_language_question(api):
    await api.post("/api/notes/", json={"title": "Sourdough", "content": "Feed the starter twice daily"})
    results = await search.keyword_search("how often should I feed my sourdough starter?")
    assert any(r["title"] == "Sourdough" for r in results)


async def test_chat_context_uses_matching_passage_not_note_start(api):
    filler = "\n\n".join(f"Paragraph {i} about gardening and tomatoes." for i in range(80))
    content = filler + "\n\nThe wifi password for the cabin is stored in the blue notebook."
    await api.post("/api/notes/", json={"title": "Cabin", "content": content})
    ctx = await search.retrieve_context("where is the cabin wifi password?", k_notes=3)
    cabin = next(c for c in ctx if c["title"] == "Cabin")
    assert "blue notebook" in cabin["text"]
    assert len(cabin["text"]) <= 2500


# --- settings and status --------------------------------------------------------

async def test_autolink_threshold_setting_validated_and_stored(api):
    assert (await api.put("/api/system/settings", json={"autolink_threshold": 5})).status_code == 422
    assert (await api.put("/api/system/settings", json={"autolink_threshold": 0.8})).status_code == 200
    assert (await api.get("/api/system/settings")).json()["autolink_threshold"] == 0.8


async def test_status_reports_ollama_state(api):
    data = (await api.get("/api/system/status")).json()
    assert data["ollama"] in ("running", "stopped")


# --- chat providers -------------------------------------------------------------

def _mock_httpx(monkeypatch, handler):
    real = httpx.AsyncClient
    monkeypatch.setattr(chat.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


async def test_openai_compatible_stream_is_parsed(monkeypatch):
    body = "".join(
        f"data: {json.dumps({'choices': [{'delta': {'content': t}}]})}\n\n" for t in ["Hel", "lo"]
    ) + "data: [DONE]\n\n"

    def handler(request):
        assert request.headers["authorization"] == "Bearer key"
        sent = json.loads(request.content)
        assert sent["stream"] is True and sent["messages"][0]["role"] == "system"
        return httpx.Response(200, text=body)

    _mock_httpx(monkeypatch, handler)
    for provider in ("openai", "mistral"):
        tokens = [t async for t in chat._stream_provider(provider, "key", "sys", [chat.Message(role="user", content="hi")])]
        assert "".join(tokens) == "Hello"


async def test_provider_auth_error_is_explained(monkeypatch):
    _mock_httpx(monkeypatch, lambda r: httpx.Response(401, text="bad key"))
    with pytest.raises(chat.ProviderHTTPError) as exc:
        [t async for t in chat._stream_provider("openai", "key", "sys", [])]
    assert "Invalid OpenAI API key" in chat._friendly_error("openai", exc.value)


async def test_missing_key_is_reported():
    with pytest.raises(ValueError):
        [t async for t in chat._stream_provider("mistral", None, "sys", [])]


async def test_rebase_note_paths_after_notes_folder_moves(api, tmp_path):
    from backend.db import rebase_note_paths
    note = (await api.post("/api/notes/", json={"title": "Moving day", "content": "boxes", "folder": "Home"})).json()
    old_root = config.SMARTNOTES_DIR
    new_root = str(tmp_path / "Dogear")
    assert await rebase_note_paths(old_root, new_root) >= 1
    moved = (await api.get(f"/api/notes/{note['id']}")).json()
    assert moved["file_path"] == os.path.join(new_root, "Home", "Moving day.md")
    # a path that merely starts with the same letters is untouched
    assert await rebase_note_paths(old_root + "-other", new_root) == 0
    await rebase_note_paths(new_root, old_root)  # put it back for other tests
