"""Syntax-only gate: no imports, runtime execution or bytecode files."""
import ast
import pathlib
import sys
for name in sys.argv[1:]:
    ast.parse(pathlib.Path(name).read_text(encoding="utf-8"), filename=name)
