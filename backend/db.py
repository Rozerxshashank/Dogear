import aiosqlite
from typing import Optional

from backend.config import DB_PATH

async def init_db():
    async with aiosqlite.connect(DB_PATH, uri=True) as db:
        # WAL lets readers and the background indexer work alongside writes
        await db.execute("PRAGMA journal_mode=WAL")
        # Create main notes table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT,
                folder TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)

        # Create FTS5 virtual table for keyword search with porter stemming
        await db.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
            USING fts5(
                id UNINDEXED,
                title,
                content,
                tokenize='porter'
            )
        """)

        # Create triggers to keep FTS index in sync with main notes table
        await db.execute("""
            CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes
            BEGIN
                INSERT INTO notes_fts(id, title, content)
                VALUES (new.id, new.title, new.content);
            END
        """)

        await db.execute("""
            CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes
            BEGIN
                UPDATE notes_fts SET
                    title = new.title,
                    content = new.content
                WHERE id = new.id;
            END
        """)

        await db.execute("""
            CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes
            BEGIN
                DELETE FROM notes_fts WHERE id = old.id;
            END
        """)

        # Execute migrations based on user_version
        cursor = await db.execute("PRAGMA user_version")
        row = await cursor.fetchone()
        current_version = row[0] if row else 0

        # Define migrations
        async def migration_1(conn):
            await conn.execute("ALTER TABLE notes ADD COLUMN file_path TEXT")
            await conn.execute("ALTER TABLE notes ADD COLUMN content_hash TEXT")

        async def migration_2(conn):
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS links (
                    source_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    link_type TEXT NOT NULL DEFAULT 'auto',
                    similarity_score REAL DEFAULT 0,
                    created_at INTEGER,
                    PRIMARY KEY (source_id, target_id, link_type),
                    FOREIGN KEY (source_id) REFERENCES notes(id) ON DELETE CASCADE,
                    FOREIGN KEY (target_id) REFERENCES notes(id) ON DELETE CASCADE
                )
            """)

        async def migration_3(conn):
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_file_path ON notes(file_path)")

        migrations = {1: migration_1, 2: migration_2, 3: migration_3}

        target_version = max(migrations.keys()) if migrations else 0

        for version in range(current_version + 1, target_version + 1):
            if version in migrations:
                await migrations[version](db)
                await db.execute(f"PRAGMA user_version = {version}")

        await db.commit()

async def get_db_connection() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH, uri=True)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute("PRAGMA busy_timeout = 5000")
    return db


async def get_setting(key: str, default: str = None) -> Optional[str]:
    db = await get_db_connection()
    try:
        async with db.execute("SELECT value FROM app_settings WHERE key = ?", (key,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else default
    finally:
        await db.close()


async def set_setting(key: str, value: str):
    db = await get_db_connection()
    try:
        await db.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        await db.commit()
    finally:
        await db.close()
