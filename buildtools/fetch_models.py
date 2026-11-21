"""Download the CPU embedding model into resources/models so packaged builds work offline."""
import os
import sys

DEST = os.path.join(os.path.dirname(__file__), "..", "resources", "models", "all-MiniLM-L6-v2")

if __name__ == "__main__":
    from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

    ONNXMiniLM_L6_V2.DOWNLOAD_PATH = os.path.abspath(DEST)
    model = ONNXMiniLM_L6_V2()
    model(["warm up"])  # triggers download + extraction
    archive = os.path.join(DEST, "onnx.tar.gz")
    if os.path.exists(archive):
        os.remove(archive)  # keep only the extracted model
    print(f"Model ready in {os.path.abspath(DEST)}")
    sys.exit(0)
