#!/usr/bin/env python3
"""Index original video PTS; analyze manually reviewed physical-event brackets.

Only Python's standard library is required; `index` also needs ffprobe/ffmpeg.
No software event or unsynchronized device clock is a latency endpoint.
"""

import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import uuid


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, data):
    # Never overwrite original annotations or an earlier analysis.
    with Path(path).open('x', encoding='utf-8') as target:
        json.dump(data, target, ensure_ascii=False, indent=2, allow_nan=False)
        target.write('\n')


def index_video(video):
    probe = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames',
        '-show_streams', '-show_entries',
        'frame=best_effort_timestamp_time,pts_time,duration_time,pkt_duration_time:'
        'stream=time_base,r_frame_rate,avg_frame_rate,width,height,nb_frames',
        '-of', 'json', str(video)], text=True))
    frames = probe['frames']
    pts = [Decimal(f['pts_time']) for f in frames]
    if len(pts) < 2 or any(b <= a for a, b in zip(pts, pts[1:])):
        raise ValueError('Need at least two strictly increasing original frame PTS')
    # No frame-rate conversion: hashes are decoded full frames in display order.
    hashes_output = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(video), '-map', '0:v:0',
        '-an', '-vsync', '0', '-f', 'framemd5', '-'], text=True)
    hashes = [line.split(',')[-1].strip() for line in hashes_output.splitlines()
              if line and not line.startswith('#')]
    if len(hashes) != len(frames):
        raise ValueError('ffprobe and decoded frame counts disagree')
    gaps = [b - a for a, b in zip(pts, pts[1:])]
    typical = statistics.median(gaps)
    return {
        'schema': 'physical-latency-video-v1',
        'video_name': Path(video).name, 'video_sha256': digest(video),
        'stream': probe['streams'][0], 'frame_count': len(frames),
        'pts_interval_seconds': {'min': str(min(gaps)), 'median': str(typical),
                                 'max': str(max(gaps))},
        'variable_pts_intervals': max(gaps) - min(gaps) > Decimal('0.000002'),
        'gap_candidates_after_frames': [i for i, gap in enumerate(gaps)
                                        if gap > typical * Decimal('1.5')],
        'identical_decoded_frame_pairs': [i for i in range(len(hashes) - 1)
                                          if hashes[i] == hashes[i + 1]],
        'limits': 'Gaps and identical images are candidates, not proof of camera '
                  'drops/duplicates. Constant PTS does not prove no sensor drops. '
                  'Exposure, rolling shutter and optical event visibility need review.',
        'frames': [dict(number=i, pts_seconds=str(pts[i]),
                        decoded_md5=hashes[i], probe=frame)
                   for i, frame in enumerate(frames)],
        'ffprobe_version': subprocess.check_output(
            ['ffprobe', '-version'], text=True).splitlines()[0],
        'ffmpeg_version': subprocess.check_output(
            ['ffmpeg', '-version'], text=True).splitlines()[0],
    }


def bracket(index, annotation):
    """Time between a reviewed last-negative and first-positive video frame."""
    before, after = annotation['last_absent'], annotation['first_present']
    if type(before) is not int or type(after) is not int:
        raise ValueError('Frame numbers must be integers')
    if not 0 <= before < after < len(index['frames']):
        raise ValueError('Invalid event bracket')
    if not annotation.get('reviewer') or not annotation.get('raw_frames_reviewed'):
        raise ValueError('Endpoints require a named raw-image reviewer')
    if not annotation.get('rule'):
        raise ValueError('An optical event interpretation rule is required')
    return tuple(Decimal(index['frames'][i]['pts_seconds']) for i in (before, after))


def analyze(index, sheet):
    if sheet['video_sha256'] != index['video_sha256']:
        raise ValueError('Annotations refer to another original video')
    recording = sheet['recording']
    if (not recording.get('original_speed_verified')
            or not recording.get('duplicate_and_gap_review')):
        raise ValueError('Review original playback speed, PTS gaps and duplicates first')
    results, seen = [], set()
    statuses = {'valid', 'failed', 'timeout', 'unreadable', 'excluded', 'not_run'}
    for row in sheet['samples']:
        key = row['event_id']
        if key in seen:
            raise ValueError('Duplicate event ID')
        seen.add(key)
        if row['metric'] not in ('display', 'feedback') or row['status'] not in statuses:
            raise ValueError('Unknown metric/status')
        if row['phase'] not in ('warmup', 'formal'):
            raise ValueError('Every event must identify warmup or formal sampling')
        result = dict(row)
        if row['status'] != 'valid':
            if not row.get('reason'):
                raise ValueError('Every non-valid event needs a reason')
            results.append(result)
            continue
        for field in ('experiment', 'session_uuid', 'round', 'source_head',
                      'builds', 'statistics_correlation'):
            if not row.get(field):
                raise ValueError('Missing provenance: ' + field)
        if row.get('annotation_method') not in ('manual', 'automatic_reviewed'):
            raise ValueError('Separate manual annotations from reviewed automatic extraction')
        a, b = bracket(index, row['start'])
        c, d = bracket(index, row['end'])
        low, high = (c - b) * 1000, (d - a) * 1000
        # Negative display bounds are possible: scanout phases can differ.
        # Preserve them; never clamp to zero or imply causality from PTS alone.
        result['pts_bracket_ms'] = [str(low), str(high)]
        margin = row.get('additional_optical_uncertainty_ms')
        if margin is not None:
            margin = Decimal(str(margin))
            if not margin.is_finite() or margin < 0 or not row.get('uncertainty_basis'):
                raise ValueError('Finite nonnegative margin and its basis required')
            result['expanded_interval_ms'] = [str(low - margin), str(high + margin)]
        else:
            result['expanded_interval_ms'] = None
        result['uncertainty_warning'] = (
            'PTS bracket alone excludes unbounded exposure/rolling-shutter/visibility '
            'effects; no fully bounded physical latency' if margin is None else None)
        results.append(result)
    summary = {}
    for metric in ('display', 'feedback'):
        subset = [r for r in results if r['metric'] == metric and r['phase'] == 'formal']
        valid = [r for r in subset if r['status'] == 'valid']
        data = {'statuses': dict(Counter(r['status'] for r in subset)),
                'warmup_statuses': dict(Counter(r['status'] for r in results
                                               if r['metric'] == metric and r['phase'] == 'warmup')),
                'valid_n': len(valid), 'percentiles': None,
                'percentile_note': 'Pilot sample: no p95/p99 or stability claim.'}
        for name in ('pts_bracket_ms', 'expanded_interval_ms'):
            intervals = [r[name] for r in valid if r[name] is not None]
            # Never summarize only the subset with convenient uncertainty bounds.
            if valid and len(intervals) == len(valid):
                lows = [Decimal(v[0]) for v in intervals]
                highs = [Decimal(v[1]) for v in intervals]
                data[name] = {
                    'median_interval': [str(statistics.median(lows)),
                                        str(statistics.median(highs))],
                    'range_envelope': [str(min(lows)), str(max(highs))]}
            else:
                data[name] = None
        summary[metric] = data
    return {'schema': 'physical-latency-analysis-v1',
            'video_sha256': index['video_sha256'], 'recording_review': recording,
            'samples': results, 'summary': summary}


def prepare(experiment, session):
    experiment, session = str(uuid.UUID(experiment)), str(uuid.UUID(session))
    return {
        'schema': 'physical-latency-annotations-v1',
        'video_sha256': None,
        'recording': {'camera_model': None, 'mode': None, 'original_speed_verified': False,
                      'exposure': None, 'rolling_shutter': None,
                      'duplicate_and_gap_review': None},
        'samples': [dict(
            event_id=f'{experiment}-{metric}-R{rnd}-{phase}{ordinal:02}',
            experiment=experiment, session_uuid=session, metric=metric, round=rnd,
            phase='warmup' if phase == 'W' else 'formal',
            status='not_run', reason='Awaiting original optical observation',
            source_head=None, builds=None, statistics_correlation=None,
            start=None, end=None, additional_optical_uncertainty_ms=None,
            uncertainty_basis=None, annotation_method=None)
            for metric in ('display', 'feedback') for rnd in (1, 2)
            for phase, count in (('W', 3), ('S', 10))
            for ordinal in range(1, count + 1)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('index')
    p.add_argument('video', type=Path)
    p.add_argument('output', type=Path)
    p = commands.add_parser('prepare')
    p.add_argument('experiment_uuid')
    p.add_argument('session_uuid')
    p.add_argument('output', type=Path)
    p = commands.add_parser('analyze')
    p.add_argument('index', type=Path)
    p.add_argument('annotations', type=Path)
    p.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.command == 'index':
        result = index_video(args.video)
    elif args.command == 'prepare':
        result = prepare(args.experiment_uuid, args.session_uuid)
    else:
        result = analyze(read(args.index), read(args.annotations))
        result['index_sha256'] = digest(args.index)
        result['annotations_sha256'] = digest(args.annotations)
    write(args.output, result)


if __name__ == '__main__':
    main()
