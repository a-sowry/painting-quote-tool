#!/usr/bin/env python3
"""Regenerate the single-file copies of each Edge Function for pasting into the Supabase dashboard editor.
Run from the repo root:  python3 tools/build-paste.py"""
import re, pathlib
root = pathlib.Path('supabase/functions')
shared = (root / '_shared' / 'shared.mjs').read_text().replace('export ', '')
for name in ['analyse-photo', 'roof-measure']:
    d = root / name
    core = (d / 'core.mjs').read_text().replace('export ', '')
    idx = re.sub(r"^import .*\n", '', (d / 'index.ts').read_text(), flags=re.M)
    out = f"// GENERATED single-file copy of _shared/shared.mjs + {name}/core.mjs + {name}/index.ts.\n// Regenerate with: python3 tools/build-paste.py\n{shared}\n{core}\n{idx}"
    (d / 'paste-into-dashboard.ts').write_text(out)
    print('wrote', d / 'paste-into-dashboard.ts', len(out), 'bytes')
