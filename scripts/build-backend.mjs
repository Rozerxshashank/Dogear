// Builds the Python backend into dist-backend/smartnotes-backend with PyInstaller,
// after making sure the offline embedding model is present.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const win = process.platform === 'win32';
const python = join('venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
if (!existsSync(python)) {
  console.error('venv not found. Create it and run: pip install -r requirements-dev.txt');
  process.exit(1);
}
const run = (args) => execFileSync(python, args, { stdio: 'inherit' });

if (!existsSync(join('resources', 'models', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx'))) {
  run(['buildtools/fetch_models.py']);
}
run(['-m', 'PyInstaller', 'buildtools/smartnotes-backend.spec', '--noconfirm',
  '--distpath', 'dist-backend', '--workpath', join('build', 'pyinstaller')]);
