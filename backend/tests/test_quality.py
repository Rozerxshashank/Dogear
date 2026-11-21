"""
Search ranking, snippets and links measured on a realistic set of notes
(backend/tests/fixtures/sample_notes). These guard what users see first.
"""
import os
import shutil

import pytest
import pytest_asyncio

from backend import config
from backend.services import search
from backend.services.reconcile import reconcile_notes_dir

pytestmark = pytest.mark.asyncio

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "sample_notes")

# question -> note(s) a person would expect first
EXPECTED_TOP = {
    "how long should bread rise": {"Sourdough"},
    "when are the movers coming": {"Apartment move"},
    "tips for staying focused at work": {"Deep Work"},
    "what did we decide about charging for migration": {"Pricing notes"},
    "who owns the import tool": {"Q3 planning"},
    "Marcus career goals": {"1-on-1 Marcus"},
    "why do customers give up during setup": {"Kickoff 12 July"},
    "too many projects at once": {"Four Thousand Weeks", "2026-07-21"},
    "things I need to buy or book": {"Inbox"},
    "wifi password new place": {"Apartment move"},
    # exact words and names must still work
    "CSV mapper": {"Q3 planning"},
    "Burkeman": {"Four Thousand Weeks"},
    "dentist": {"Apartment move"},
    "250°C": {"Sourdough"},
}


@pytest_asyncio.fixture
async def sample_notes(api):
    """A notes folder containing only the sample notes, indexed."""
    for name in os.listdir(config.SMARTNOTES_DIR):
        path = os.path.join(config.SMARTNOTES_DIR, name)
        shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
    shutil.copytree(FIXTURES, config.SMARTNOTES_DIR, dirs_exist_ok=True)
    await reconcile_notes_dir()
    notes = (await api.get("/api/notes/")).json()
    return {n["title"]: n for n in notes}


async def test_search_puts_the_expected_note_first(sample_notes):
    misses = []
    for query, expected in EXPECTED_TOP.items():
        results = await search.hybrid_search(query, k=3)
        top = results[0]["title"] if results else None
        if top not in expected:
            misses.append(f"{query!r}: got {top!r}, expected {sorted(expected)}")
    assert not misses, "\n".join(misses)


async def test_search_snippets_are_plain_text(sample_notes):
    results = await search.hybrid_search("tips for staying focused at work", k=3)
    deep = next(r for r in results if r["title"] == "Deep Work")
    assert not deep["text"].startswith("#")
    assert "**" not in deep["text"] and "[[" not in deep["text"]


async def test_make_snippet_strips_markdown_and_repeated_title():
    text = "# Deep Work — Cal Newport\n\nThe ability to **focus**. See [[Four Thousand Weeks|that book]] and [a](https://x.y)\n- one"
    assert search.make_snippet(text, "Deep Work") == "The ability to focus. See that book and a one"


async def test_wikilinks_in_sample_notes_become_links(sample_notes, api):
    q3 = sample_notes["Q3 planning"]
    linked = {n["title"] for n in (await api.get(f"/api/notes/{q3['id']}/links")).json()}
    assert {"Pricing notes", "Kickoff 12 July"} <= linked


async def test_graph_has_one_edge_per_pair_and_unrelated_notes_stay_apart(sample_notes, api):
    graph = (await api.get("/api/graph/")).json()
    titles = {n["id"]: n["label"] for n in graph["nodes"]}
    pairs = [frozenset((titles[e["source"]], titles[e["target"]])) for e in graph["edges"]]
    assert len(pairs) == len(set(pairs)), "duplicate edges for the same pair"
    assert frozenset(("Q3 planning", "Pricing notes")) in pairs
    connected = {t for pair in pairs for t in pair}
    assert "Sourdough" not in connected  # a bread recipe has nothing to do with work notes


async def test_typed_wikilink_becomes_link_and_resolves_when_target_is_created(api):
    source = (await api.post("/api/notes/", json={"title": "Trip ideas", "content": "Ask about [[Lisbon hotels]]"})).json()
    assert (await api.get(f"/api/notes/{source['id']}/links")).json() == []

    target = (await api.post("/api/notes/", json={"title": "Lisbon hotels", "content": "Shortlist"})).json()
    links = (await api.get(f"/api/notes/{source['id']}/links")).json()
    assert [link["id"] for link in links] == [target["id"]]

    # Removing the [[link]] from the text removes the typed link
    # (an automatic link may remain if the notes are still similar)
    await api.put(f"/api/notes/{source['id']}", json={"content": "Changed my mind"})
    edges = (await api.get("/api/graph/")).json()["edges"]
    manual = [e for e in edges if {e["source"], e["target"]} == {source["id"], target["id"]} and e["link_type"] == "manual"]
    assert manual == []


async def test_precise_searches_do_not_list_unrelated_notes(sample_notes):
    results = await search.hybrid_search("wifi password new place", k=10)
    assert [r["title"] for r in results] == ["Apartment move"]
    # ...while broader questions still surface related notes
    related = [r["title"] for r in await search.hybrid_search("tips for staying focused at work", k=10)]
    assert related[:2] == ["Deep Work", "Four Thousand Weeks"]
