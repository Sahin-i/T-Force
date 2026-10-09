"""Reject private runtime/configuration files in the Git-tracked source release."""
from pathlib import PurePosixPath
import subprocess
import sys

excluded_directories = {
    ".agent-state", "workspace", "node_modules", "dist", "deliverables",
    "demo-assets", ".pitch-build", "test-results", "playwright-report",
    ".aws", ".azure", ".codex", ".agents", ".venv", "venv", "__pycache__",
}
files = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
blocked = []
for filename in filter(None, files):
    path = PurePosixPath(filename)
    if (
        any(part in excluded_directories for part in path.parts[:-1])
        or path.name.startswith((".env", "~$"))
        or path.name in {".npmrc", ".DS_Store"}
        or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".pyc", ".log"}
    ):
        blocked.append(filename)
if blocked:
    print("Private or generated files are tracked:\n" + "\n".join(blocked))
    sys.exit(1)
print("Public source file check passed.")
