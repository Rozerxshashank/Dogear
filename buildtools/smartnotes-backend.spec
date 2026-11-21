# PyInstaller spec: builds dist-backend/smartnotes-backend (one-folder bundle)
# Run from the repo root:  pyinstaller buildtools/smartnotes-backend.spec --noconfirm
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

datas, binaries, hiddenimports = [], [], []
for pkg in ("chromadb", "onnxruntime", "tokenizers", "langchain_text_splitters", "google.genai", "ollama"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
hiddenimports += collect_submodules("backend")
hiddenimports += collect_submodules("uvicorn")

a = Analysis(
    [os.path.join(SPECPATH, "backend_entry.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    # Optional ML stacks pulled in by optional imports; the app only needs onnxruntime + tokenizers
    excludes=["torch", "sentence_transformers", "transformers", "tensorflow", "scipy", "sklearn",
              "hf_xet", "matplotlib", "tkinter", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="smartnotes-backend",
    console=True,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="smartnotes-backend", upx=False)
