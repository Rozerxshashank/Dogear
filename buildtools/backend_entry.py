"""PyInstaller entry point for the bundled backend."""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from backend.main import run
    run()
