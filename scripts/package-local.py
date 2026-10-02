#!/usr/bin/env python3
"""Package a runnable local site; never contacts GitHub or Cloudflare."""
from pathlib import Path
import os, hashlib, zipfile, json
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / 'RLTTTSK_улучшенная_локальная_версия_2026_10_02.zip'
SKIP_DIRS = {'node_modules', '.git', '.wrangler', '__pycache__', 'prepared'}
ALLOW_ARTIFACTS = {'training_report.json', 'feature_importance.csv', 'fns_supplier_enrichment.csv.gz', 'supplier_contacts.csv'}
def files():
    for directory, names, filenames in os.walk(ROOT):
        names[:] = [name for name in names if name not in SKIP_DIRS]
        for name in filenames:
            path = Path(directory) / name
            relative = path.relative_to(ROOT)
            if name == '.DS_Store' or name.startswith('.env') or name.endswith('.pyc'): continue
            if relative.as_posix() == 'qa/package-report.json': continue
            if relative.parts[:2] == ('backend', 'artifacts') and name not in ALLOW_ARTIFACTS: continue
            if relative.parts[:2] == ('cloudflare', 'generated') and name not in {'model.json', 'local.sqlite', 'local_data_report.json'}: continue
            yield path
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024): h.update(chunk)
    return h.hexdigest()
entries = sorted(files())
manifest = ROOT / 'MANIFEST.sha256'
manifest.write_text('\n'.join(digest(p) + '  ' + p.relative_to(ROOT).as_posix() for p in entries if p != manifest) + '\n')
if manifest not in entries: entries.append(manifest)
with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
    for path in entries: archive.write(path, ROOT.name + '/' + path.relative_to(ROOT).as_posix())
with zipfile.ZipFile(OUT) as archive:
    bad = archive.testzip()
    if bad: raise ValueError('Bad archive member: ' + bad)
result = {'archive': str(OUT), 'bytes': OUT.stat().st_size, 'sha256': digest(OUT), 'members': len(entries), 'archive_integrity': 'passed'}
OUT.with_suffix('.sha256').write_text(result['sha256'] + '  ' + OUT.name + '\n')
(ROOT / 'qa' / 'package-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
