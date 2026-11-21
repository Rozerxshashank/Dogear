# SmartNotes

SmartNotes is a fully local AI notes app. It gives you an easy way to write markdown notes while letting you chat with your knowledge base, search semantically, and see how your notes connect in a visual knowledge graph.

Everything stays on your local machine for privacy. There are no cloud dependencies unless you explicitly choose to use a cloud AI provider.

## Features

* **Local First:** All notes are saved as standard Markdown files on your computer.
* **Smart Search:** Find what you are looking for by meaning, not just exact keywords.
* **Chat with your Notes:** Ask questions and get answers grounded purely in the notes you have written, complete with citations.
* **Auto-linking:** The app automatically finds related notes and links them for you.
* **Knowledge Graph:** Visualize the connections between all your notes.
* **GitHub Sync:** Easily backup or sync your notes to a private GitHub repository.

## Development

You need Node.js 22+ and Python 3.11+ (CI uses 3.14).

```bash
npm install
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements-dev.txt
python buildtools/fetch_models.py # offline CPU embedding model (~90 MB, once)
npm run dev
```

`npm run dev` starts Vite and Electron; Electron starts the Python backend on a free local port.

### Optional: Ollama for local chat and better embeddings

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

Without Ollama, search and auto-linking use the built-in CPU model, and chat works with a cloud provider (OpenAI, Mistral or Gemini) whose API key you enter in Settings. The status dot in the sidebar shows what is available.

## Tests and checks

```bash
npm run typecheck && npm test                       # renderer + Electron
venv/bin/ruff check backend buildtools              # backend lint
venv/bin/python -m pytest backend/tests -q          # backend tests
```

CI runs all of these on every push and pull request (`.github/workflows/ci.yml`).

## Building installers

```bash
npm run dist
```

This bundles the backend with PyInstaller, then packages the app with electron-builder into `release/` (DMG/ZIP on macOS, NSIS installer on Windows, AppImage on Linux). Build each platform on that platform; pushing a `v*` tag builds all three in CI.

Before distributing publicly, add code-signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, and for macOS notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and an app icon in `build/`.

## Where things are stored

| What | Where |
|---|---|
| Your notes (Markdown, with sub-folders) | `~/Documents/SmartNotes` |
| Database, search index, logs | the app's data folder (macOS: `~/Library/Application Support/SmartNotes`) |
| API keys and GitHub token | encrypted with the OS keychain (`secrets.json` in the data folder) |
