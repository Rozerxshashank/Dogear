"""
Manual links from [[wikilinks]] in note text.

Links are rebuilt from a note's content whenever it is saved, changed on disk or
imported, so the Related panel and graph always match what the note says.
"""
import os
import re
import time

_WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")


def extract_wikilinks(content: str) -> list[str]:
    """Targets of [[Target]], [[Target|alias]], [[Target#heading]] and [[folder/Target]]."""
    targets = []
    for raw in _WIKILINK.findall(content or ""):
        target = raw.split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            targets.append(os.path.basename(target.replace("\\", "/")))
    return targets


async def _title_index(db) -> dict:
    async with db.execute("SELECT id, title FROM notes ORDER BY updated_at DESC") as cursor:
        index = {}
        for note_id, title in await cursor.fetchall():
            index.setdefault((title or "").strip().lower(), note_id)
        return index


async def sync_manual_links(db, note_id: str, content: str, index: dict = None):
    """Replace a note's manual links with the [[wikilinks]] currently in its text. Caller commits."""
    index = index if index is not None else await _title_index(db)
    await db.execute("DELETE FROM links WHERE source_id = ? AND link_type = 'manual'", (note_id,))
    now = int(time.time())
    for target in dict.fromkeys(t.lower() for t in extract_wikilinks(content)):
        target_id = index.get(target)
        if target_id and target_id != note_id:
            await db.execute(
                "INSERT OR IGNORE INTO links (source_id, target_id, link_type, similarity_score, created_at) "
                "VALUES (?, ?, 'manual', 1.0, ?)",
                (note_id, target_id, now),
            )


async def relink_mentions_of(db, title: str):
    """A note was created or renamed: notes that already [[mention]] it now resolve. Caller commits."""
    if not title:
        return
    pattern = f"%[[{title.strip()}%"
    async with db.execute("SELECT id, content FROM notes WHERE content LIKE ? COLLATE NOCASE", (pattern,)) as cursor:
        rows = await cursor.fetchall()
    if not rows:
        return
    index = await _title_index(db)
    for note_id, content in rows:
        await sync_manual_links(db, note_id, content or "", index)


async def rebuild_all_manual_links(db):
    """Recompute every note's manual links (startup, after reconcile or import). Caller commits."""
    index = await _title_index(db)
    async with db.execute("SELECT id, content FROM notes") as cursor:
        rows = await cursor.fetchall()
    for note_id, content in rows:
        await sync_manual_links(db, note_id, content or "", index)
