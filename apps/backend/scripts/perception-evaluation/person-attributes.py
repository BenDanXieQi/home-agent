"""Offline native PP-LCNet visible attributes on the fixed Real28 archive."""
import argparse
import hashlib
import importlib.metadata
import json
import platform
import threading
import time
import zipfile
from pathlib import Path

ARCHIVE_SHA = 'bb84e9dfed9e1a9801bfd7617e6addc44cee36d483d777b2db5d1308170d5de8'
MODEL_SHA = 'd1d28223d1ff7a1b0b1ff2e9af6747df143c228ec6e9bd78e7f91ab6b2ced5df'
PROTOCOL = {
    'candidate': 'two-clothing-group acceptance veto; no rescoring or candidate removal',
    'reidThreshold': 0.94, 'reidMargin': 0.13,
    'attributeMinScore': 0.9, 'attributeMinLead': 0.3,
    'sleeveIndices': [2, 3], 'lowerIndices': [11, 12, 13],
    'unknown': 'low score or small lead; no verified visibility/completeness ground truth',
    'veto': 'only baseline acceptances; both known sleeve and lower disagree with highest-ReID reference; change acceptance to unknown, never assert different identity',
    'orientation': 'description only; never identity conflict',
    'excluded': ['age', 'gender', 'bag/hat as identity conflict', 'color labels'],
    'split': 'reuse frozen identity-disjoint Real28 manifest; tune first, holdout once; no threshold search',
    'limitations': ['static crops without timestamps', 'no attribute/pose/occlusion/low-light ground truth', 'high scores do not prove visibility or correctness', 'no household or temporal inference'],
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def known(scores, indices):
    order = sorted(indices, key=lambda i: scores[str(i)], reverse=True)
    return order[0] if scores[str(order[0])] >= PROTOCOL['attributeMinScore'] and scores[str(order[0])] - scores[str(order[1])] >= PROTOCOL['attributeMinLead'] else None


def compare(args):
    protocol_path = args.output / 'protocol.json'
    frozen = read(protocol_path)
    if frozen['rules'] != PROTOCOL or frozen['scriptSha256'] != sha(Path(__file__)):
        raise ValueError('Frozen protocol differs; use a new output directory')
    if frozen['observationsSha256'] != sha(args.baseline / 'observations.json') or frozen['manifestSha256'] != sha(args.baseline / 'manifest.json'):
        raise ValueError('Frozen ReID observations changed')
    rows = read(args.baseline / 'observations.json')
    raw = read(args.output / f'{args.split}-raw.json')
    if raw['protocolSha256'] != sha(protocol_path) or raw['manifestSha256'] != frozen['manifestSha256']:
        raise ValueError('Attribute output belongs to another protocol or input')
    if raw['modelFiles'] != frozen['modelFiles'] or raw['sourceFiles'] != frozen['sourceFiles'] or raw['scriptSha256'] != frozen['scriptSha256'] or raw['archiveSha256'] != MODEL_SHA:
        raise ValueError('Attribute output asset or implementation binding differs')
    expected = {r['file']: r['sha256'] for r in read(args.baseline / 'manifest.json') if r['split'] == args.split}
    if {r['file']: r['sha256'] for r in raw['samples']} != expected or len(raw['samples']) != len(expected):
        raise ValueError('Attribute samples differ from frozen split')
    attributes = {x['file']: x['scores'] for x in raw['samples']}
    groups = {}
    decisions = []
    for row in rows:
        if row['split'] != args.split:
            continue
        accepted = row['bestScore'] >= PROTOCOL['reidThreshold'] and row['margin'] >= PROTOCOL['reidMargin']
        ref = max((r for r in row['references'] if r['identity'] == row['bestIdentity']), key=lambda r: r['score'])
        target_scores, ref_scores = attributes[row['file']], attributes[ref['file']]
        pairs = [(known(target_scores, indices), known(ref_scores, indices)) for indices in (PROTOCOL['sleeveIndices'], PROTOCOL['lowerIndices'])]
        veto = accepted and all(a is not None and b is not None and a != b for a, b in pairs)
        result = 'unknown' if not accepted else 'correct' if row['enrolled'] and row['bestIdentity'] == row['identity'] else 'wrong'
        candidate = 'unknown' if veto else result
        key = f"{row['cameraScope']}/{row['scenario']}"
        group = groups.setdefault(key, {'count': 0, 'baseline': dict(correct=0, wrong=0, unknown=0), 'candidate': dict(correct=0, wrong=0, unknown=0), 'correctScoreCeiling': 0, 'attributePairKnown': 0})
        group['count'] += 1
        group['baseline'][result] += 1
        group['candidate'][candidate] += 1
        group['correctScoreCeiling'] += int(row['correctScore'] is not None and row['correctScore'] >= PROTOCOL['reidThreshold'])
        group['attributePairKnown'] += int(all(a is not None and b is not None for a, b in pairs))
        decisions.append({'file': row['file'], 'cameraScope': row['cameraScope'], 'reference': ref['file'], 'sleeveLowerPairs': pairs, 'baseline': result, 'candidate': candidate})
    save(args.output / f'{args.split}-comparison.json', {'protocolSha256': sha(protocol_path), 'rawSha256': sha(args.output / f'{args.split}-raw.json'), 'groups': groups, 'decisions': decisions})
    print(json.dumps(groups, indent=2), flush=True)


def read_assets(args):
    if sha(args.archive) != ARCHIVE_SHA or sha(args.model_archive) != MODEL_SHA:
        raise ValueError('Archive fingerprint differs from the fixed assets')
    names = ['inference.pdmodel', 'inference.pdiparams', 'infer_cfg.yml', 'inference.pdiparams.info']
    with zipfile.ZipFile(args.model_archive) as archive:
        for name in names:
            packed = archive.read(f'PPLCNet_x1_0_person_attribute_945_infer/{name}')
            if packed != (args.model / name).read_bytes():
                raise ValueError(f'Extracted model asset differs: {name}')
    return {'modelFiles': {name: sha(args.model / name) for name in names},
            'sourceFiles': {name: sha(args.sources / name) for name in ['attr_infer.py', 'preprocess.py', 'LICENSE']},
            'inputArchiveSha256': ARCHIVE_SHA, 'modelArchiveSha256': MODEL_SHA}


def infer(args):
    import_start = time.perf_counter()
    import cv2
    import numpy as np
    import paddle
    import psutil
    import yaml
    from paddle.inference import Config, create_predictor

    import_ms = (time.perf_counter() - import_start) * 1000
    cv2.setNumThreads(1)
    frozen = read(args.output / 'protocol.json')
    if frozen['rules'] != PROTOCOL or frozen['scriptSha256'] != sha(Path(__file__)) or frozen['observationsSha256'] != sha(args.baseline / 'observations.json') or frozen['manifestSha256'] != sha(args.baseline / 'manifest.json'):
        raise ValueError('Frozen protocol or manifest changed')
    assets = read_assets(args)
    if any(assets[key] != frozen[key] for key in assets):
        raise ValueError('Frozen asset binding changed')
    cfg = yaml.safe_load((args.model / 'infer_cfg.yml').read_text())
    labels = cfg['label_list']
    visible = list(range(19)) + [23, 24, 25]
    expected = [{'keep_ratio': False, 'target_size': [256, 192], 'type': 'Resize'}, {'is_scale': True, 'mean': [0.485, 0.456, 0.406], 'std': [0.229, 0.224, 0.225], 'type': 'NormalizeImage'}, {'type': 'Permute'}]
    if cfg['Preprocess'] != expected:
        raise ValueError('Unexpected model preprocessing')
    process = psutil.Process()
    rss = []
    stop = threading.Event()

    def sample_memory():
        while not stop.is_set():
            rss.append(process.memory_info().rss)
            stop.wait(0.02)

    sampler = threading.Thread(target=sample_memory)
    sampler.start()
    try:
        start = time.perf_counter()
        config = Config(str(args.model / 'inference.pdmodel'), str(args.model / 'inference.pdiparams'))
        config.disable_gpu()
        config.set_cpu_math_library_num_threads(1)
        config.enable_new_ir(False)
        config.disable_glog_info()
        predictor = create_predictor(config)
        load_ms = (time.perf_counter() - start) * 1000
        input_handle = predictor.get_input_handle('x')
        output_handle = predictor.get_output_handle(predictor.get_output_names()[0])
        manifest = read(args.baseline / 'manifest.json')
        selected = {r['file']: r for r in manifest if r['split'] == args.split}
        samples, timings = [], []
        # Official NormalizeImage uses default np.array dtype and in-place float32 writes.
        mean = np.array(expected[1]['mean'])[None, None, :]
        std = np.array(expected[1]['std'])[None, None, :]
        total_start = time.perf_counter()
        with zipfile.ZipFile(args.archive) as archive:
            for file, row in selected.items():
                start = time.perf_counter()
                encoded = archive.read(file)
                if hashlib.sha256(encoded).hexdigest() != row['sha256']:
                    raise ValueError(f'Crop fingerprint differs: {file}')
                image = cv2.cvtColor(cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), 1), cv2.COLOR_BGR2RGB)
                decoded = time.perf_counter()
                image = cv2.resize(image, None, fx=192/image.shape[1], fy=256/image.shape[0], interpolation=cv2.INTER_LINEAR).astype(np.float32)
                image *= 1.0 / 255.0
                image -= mean
                image /= std
                tensor = image.transpose(2, 0, 1).copy()[None, :]
                prepared = time.perf_counter()
                input_handle.reshape(tensor.shape)
                input_handle.copy_from_cpu(tensor)
                predictor.run()
                scores = output_handle.copy_to_cpu()[0]
                end = time.perf_counter()
                if len(scores) != 26 or not np.isfinite(scores).all():
                    raise ValueError('Invalid attribute output')
                # Age/gender are discarded immediately, never saved or used.
                samples.append({'file': file, 'sha256': row['sha256'], 'scores': {str(i): float(scores[i]) for i in visible}})
                timings.append({'decodeMs': (decoded-start)*1000, 'preprocessMs': (prepared-decoded)*1000, 'inferenceMs': (end-prepared)*1000, 'totalMs': (end-start)*1000})
                if len(samples) % 200 == 0:
                    print(f'{args.split}: {len(samples)}/{len(selected)}', flush=True)
        elapsed = time.perf_counter() - total_start
    finally:
        stop.set()
        sampler.join()
    steady = timings[3:]
    resources = {'importMs': import_ms, 'loadMs': load_ms, 'wallSeconds': elapsed, 'warmupExcluded': 3, 'steadySamples': len(steady), 'rssSamplingMs': 20, 'sampledPeakRssBytes': max(rss), 'rssSamples': len(rss), 'timingMs': {key: {'mean': float(np.mean([x[key] for x in steady])), 'p50': float(np.percentile([x[key] for x in steady], 50)), 'p95': float(np.percentile([x[key] for x in steady], 95))} for key in steady[0]}}
    save(args.output / f'{args.split}-raw.json', {'scriptSha256': sha(Path(__file__)), 'protocolSha256': sha(args.output / 'protocol.json'), 'manifestSha256': sha(args.baseline / 'manifest.json'), 'modelFiles': assets['modelFiles'], 'archiveSha256': MODEL_SHA, 'sourceFiles': assets['sourceFiles'], 'labelMap': {str(i): labels[i] for i in visible}, 'environment': {'python': platform.python_version(), 'os': platform.platform(), 'arch': platform.machine(), 'processor': platform.processor(), 'dependencies': {p: importlib.metadata.version(p) for p in ['paddlepaddle', 'numpy', 'opencv-python-headless', 'PyYAML', 'psutil']}, 'paddleMathThreads': 1, 'opencvThreads': cv2.getNumThreads(), 'device': 'native CPU', 'newIr': False, 'batch': 1}, 'resources': resources, 'samples': samples})
    print(json.dumps(resources, indent=2), flush=True)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('stage', choices=['freeze', 'infer', 'compare'])
parser.add_argument('--baseline', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--split', choices=['tune', 'holdout'])
parser.add_argument('--archive', type=Path)
parser.add_argument('--model', type=Path)
parser.add_argument('--model-archive', type=Path)
parser.add_argument('--sources', type=Path)
args = parser.parse_args()
if args.stage != 'freeze' and args.split is None:
    parser.error('--split is required for infer and compare')
if args.stage in ['freeze', 'infer'] and any(getattr(args, key) is None for key in ['archive', 'model', 'model_archive', 'sources']):
    parser.error('freeze/infer requires --archive, --model, --model-archive and --sources')
args.output.mkdir(parents=True, exist_ok=True)
if args.stage == 'freeze':
    path = args.output / 'protocol.json'
    if path.exists():
        raise ValueError('Protocol already exists; use a new output directory')
    save(path, {**read_assets(args), 'rules': PROTOCOL, 'manifestSha256': sha(args.baseline / 'manifest.json'), 'observationsSha256': sha(args.baseline / 'observations.json'), 'scriptSha256': sha(Path(__file__)), 'frozenAtUnixSeconds': time.time()})
elif args.stage == 'infer':
    infer(args)
else:
    # JSON object keys hold original model output indices.
    compare(args)
