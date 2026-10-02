#!/usr/bin/env python3
"""Build real, local serving data without retraining or changing the saved model."""
import argparse
import json
import sqlite3
from pathlib import Path
from prepare_catboost_data import ROOT, read_inputs, save_profiles, save_search_catalog
from export_cloudflare import export_profiles, OUT
from export_enrichment import main as export_enrichment
import sys

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    args = parser.parse_args()
    base, cleaning = read_inputs(args.data_dir)
    print(json.dumps(cleaning, ensure_ascii=False), flush=True)
    save_profiles(base[base['purchase_channel'].eq('ЭМ')], ROOT / 'artifacts')
    save_search_catalog(base, ROOT / 'artifacts')
    export_profiles()
    sys.argv = [sys.argv[0]]
    export_enrichment()
    path = OUT / 'local.sqlite'
    if path.exists(): path.unlink()
    connection = sqlite3.connect(path)
    for name in ('data.sql', 'enrichment.sql'):
        print('Importing', name, flush=True)
        connection.executescript((OUT / name).read_text())
    connection.commit()
    count = connection.execute('SELECT COUNT(*) FROM store').fetchone()[0]
    connection.close()
    report = {'source': 'Provided procurement archive 2024–2025', 'model_retrained': False,
              'store_rows': count, 'suppliers': int(base.supplier_inn.nunique()),
              'historical_budget_policy': 'Notice start price; amounts over 1bn RUB withheld for review; no unit price or quote inferred',
              'contacts_source': 'backend/artifacts/supplier_contacts.csv', 'cleaning': cleaning}
    (OUT / 'local_data_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)

if __name__ == '__main__': main()
