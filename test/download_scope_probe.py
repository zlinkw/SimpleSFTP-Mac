"""Run the selected archive helper without creating a transient script."""
import base64
import sys

exec(compile(base64.b64decode(sys.argv[1]), "scoped_archive_fixture", "exec"))
