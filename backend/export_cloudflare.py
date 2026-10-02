#!/usr/bin/env python3
"""Export the trained CatBoost trees and indexed supplier profiles for Workers + D1."""
import importlib.util
import json
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd
from catboost import CatBoostRanker, Pool
from model_schema import CATEGORICAL, FEATURES, PRICE_CAP_EM, SCHEMA_VERSION
from text_features import ENDINGS, GENERIC_STEMS, tokens

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / 'cloudflare' / 'generated'
ARTIFACTS = ROOT / 'artifacts'

def bucket(term):
    value = 2166136261
    for char in term:
        value = ((value ^ ord(char)) * 16777619) & 0xffffffff
    return value % 512

def read(name):
    return pd.read_csv(ARTIFACTS / name, dtype={'supplier_inn': str, 'customer_inn': str, 'category_division': str}, keep_default_na=False)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    packed = {}
    model = CatBoostRanker()
    model.load_model(str(ARTIFACTS / 'supplier_ranker.cbm'))
    if model.feature_names_ != FEATURES:
        raise ValueError('Model and feature schema differ')
    divisions = ['unknown'] + [f'{i:02d}' for i in range(100)]
    frame = pd.DataFrame([{f: (division if f in CATEGORICAL else 0) for f in FEATURES} for division in divisions], columns=FEATURES)
    with TemporaryDirectory() as directory:
        path = Path(directory) / 'model.py'
        model.save_model(str(path), format='python', pool=Pool(frame, cat_features=CATEGORICAL))
        spec = importlib.util.spec_from_file_location('exported_catboost', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        exported = module.catboost_model
        # The lookup is exact because this model's CTRs depend only on its one category.
        if any(c.projection.binarized_indexes or c.projection.transposed_cat_feature_indexes != [0]
               for c in exported.model_ctrs.compressed_model_ctrs):
            raise ValueError('This exporter requires category-only CTRs')
        category_bins = {}
        for division in divisions:
            ctrs = [0.] * exported.model_ctrs.used_model_ctrs_count
            module.calc_ctrs(exported.model_ctrs, [0] * exported.binary_feature_count, [module.hash_uint64(division)], ctrs)
            category_bins[division] = [sum(value > border for border in borders) for value, borders in zip(ctrs, exported.ctr_feature_borders)]
        packed = {name: getattr(exported, name) for name in [
            'float_features_index', 'float_feature_borders', 'tree_depth', 'tree_split_border',
            'tree_split_feature_index', 'tree_split_xor_mask', 'scale', 'biases',
        ]}
        packed['leaf_values'] = [value[0] for value in exported.leaf_values]
        packed.update(category_bins=category_bins, features=FEATURES, schema_version=SCHEMA_VERSION, price_cap=PRICE_CAP_EM,
                      endings=ENDINGS, generic_stems=sorted(GENERIC_STEMS))

    suppliers = defaultdict(lambda: {'catalog': {}, 'categories': {}, 'global': {}})
    buyers = defaultdict(dict)
    for record in read('supplier_global.csv.gz').to_dict('records'):
        inn = record.pop('supplier_inn')
        suppliers[inn]['global'] = record
    for record in read('supplier_by_category.csv.gz').to_dict('records'):
        inn, division = record.pop('supplier_inn'), record.pop('category_division')
        suppliers[inn]['categories'][division] = record
    for record in read('supplier_by_buyer.csv.gz').itertuples(index=False):
        buyers[record.supplier_inn][record.customer_inn] = [int(record.buyer_participations), int(record.buyer_wins), {}]
    for record in read('supplier_by_buyer_category.csv.gz').itertuples(index=False):
        if record.customer_inn in buyers[record.supplier_inn]:
            buyers[record.supplier_inn][record.customer_inn][2][record.category_division] = int(record.buyer_category_wins)
    postings = defaultdict(set)
    for record in read('supplier_search_catalog.csv.gz').to_dict('records'):
        inn, division = record.pop('supplier_inn'), record.pop('category_division')
        if inn.startswith('0000'):
            continue
        examples = json.loads(record.pop('examples_json') or '[]')
        record.pop('example_text', None)
        record['examples'] = [{'text': text, 'tokens': sorted(tokens(text))} for text in examples]
        suppliers[inn]['catalog'][division] = record
        for example in record['examples']:
            for term in example['tokens']:
                postings[term].add(inn)
        postings['@' + division].add(inn)
    external = ARTIFACTS / 'external_supplier_pool.csv'
    if external.exists():
        for record in pd.read_csv(external, dtype=str, keep_default_na=False).to_dict('records'):
            inn = record['supplier_inn']
            suppliers[inn]['external'] = record
            for division in [code.split('.')[0] for code in json.loads(record['okpd2_codes'])]:
                postings['@' + division].add(inn)
            for term in tokens(record.get('profile_text', '')):
                postings[term].add(inn)
    # Higher observed activity breaks retrieval ties; CatBoost still decides the final order.
    activity = {inn: sum(int(c['observed_lots']) for c in value['catalog'].values()) for inn, value in suppliers.items()}
    indexes = defaultdict(dict)
    for term, inns in postings.items():
        indexes[bucket(term)][term] = sorted(inns, key=lambda inn: (-activity.get(inn, 0), inn))
    packed['search_vocabulary'] = sorted(postings)
    packed['search_term_frequency'] = {term: len(inns) for term, inns in postings.items()}
    (OUT / 'model.json').write_text(json.dumps(packed, ensure_ascii=False, separators=(',', ':')))
    rows = 0
    with (OUT / 'data.sql').open('w') as sql:
        sql.write('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;\n')
        def emit(key, value):
            nonlocal rows
            encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
            # Each SQL statement stays below D1's 100 KB limit, including UTF-8 and escaping.
            chunks = [encoded[i:i + 14000] for i in range(0, len(encoded), 14000)]
            for part, chunk in enumerate(chunks):
                k = (key + ':' + f'{part:05d}').replace("'", "''")
                sql.write("INSERT INTO store VALUES ('" + k + "','" + chunk.replace("'", "''") + "');\n")
                rows += 1
        for inn, value in suppliers.items():
            emit('s:' + inn, value)
        for inn, value in buyers.items():
            emit('b:' + inn, value)
        for key, value in indexes.items():
            emit('t:' + str(key), value)
        emit('meta', {'schema_version': SCHEMA_VERSION, 'supplier_count': len(suppliers),
                      'catalog_rows': sum(len(value['catalog']) for value in suppliers.values())})
    if rows > 90000:
        raise ValueError(f'Import would use {rows} rows; reduce it before a Free-plan deployment')
    print(json.dumps({'suppliers': len(suppliers), 'search_terms': len(postings), 'import_rows': rows,
                     'sql_mb': round((OUT / 'data.sql').stat().st_size / 1e6, 2),
                     'model_kb': round((OUT / 'model.json').stat().st_size / 1e3, 1)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
