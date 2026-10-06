#!/usr/bin/env python3
"""Summarize fixed LAN and measurement-overhead runs without mixing clocks."""
import argparse
from collections import Counter
import json
from pathlib import Path

from software import GROUPS, digest, ns, stages, summary


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def statistics_window(path, manifest):
    if manifest.get('clock') != 'elapsedRealtimeNanos':
        raise ValueError('Window must use receiver elapsedRealtimeNanos')
    start, finish = ns(manifest['start_ns']), ns(manifest['end_ns'])
    if finish <= start:
        raise ValueError('Invalid window ordering')
    records = [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line]
    rows = [r for r in records if r.get('event') == 'receiver_sample']
    previous_seq, previous_time = 0, -1
    selected, valid = [], []
    for row in rows:
        sample = row['sample']
        if sample['session'] != manifest['session']:
            raise ValueError('Statistics belong to another session')
        observed = ns(sample['receiver_observed_ns'])
        if sample['seq'] <= previous_seq or observed <= previous_time:
            raise ValueError('Statistics are duplicated or out of order')
        previous_seq, previous_time = sample['seq'], observed
        usable = sample.get('state') in {'sampled', 'no_new_decoded_frames'}
        duration = ns(sample['receiver_window_ns']) if usable else None
        if usable and not 0 < duration <= 10_000_000_000:
            raise ValueError('Invalid receiver sampling window')
        overlaps = usable and observed > start and observed-duration < finish
        if start <= observed <= finish or overlaps:
            selected.append(row)
        if not overlaps:
            continue
        value = sample.copy()
        value['weight_ns'] = min(finish, observed) - max(start, observed-duration)
        if valid and observed-duration < ns(valid[-1]['receiver_observed_ns']):
            raise ValueError('Overlapping receiver statistics windows')
        valid.append(value)
    covered = sum(r['weight_ns'] for r in valid)
    def weighted(name):
        values = [r for r in valid if r.get(name) is not None and r['weight_ns'] > 0]
        total = sum(r['weight_ns'] for r in values)
        return sum(r[name]*r['weight_ns'] for r in values)/total if total else None
    counters = {}
    # Deltas need both endpoints inside the chosen window. They can undercount
    # at its edges; never attribute a whole-session counter to a partial window.
    for name in ('freezeCount', 'totalFreezesDuration', 'pauseCount', 'totalPausesDuration', 'packetsLost', 'framesDropped'):
        values = [r['sample']['raw'].get(name) for r in selected
                  if start<=ns(r['sample']['receiver_observed_ns'])<=finish]
        values = [v for v in values if isinstance(v, (int, float))]
        counters[name] = values[-1]-values[0] if len(values)>1 and all(b>=a for a,b in zip(values,values[1:])) else None
    result = {'statistics_samples': len(selected), 'valid_window_ms': covered/1_000_000,
              'coverage_ratio': covered/(finish-start),
              'weighted_decoded_fps': weighted('decoded_fps'),
              'weighted_payload_kbps': weighted('received_payload_kbps'),
              'weighted_mean_decode_ms': weighted('mean_decode_ms'),
              'decoded_resolutions': sorted({(r['raw'].get('frameWidth'),r['raw'].get('frameHeight')) for r in valid},key=str),
              'statistics_states': dict(Counter(r['sample']['state'] for r in selected)),
              'missing_sequences': sum(r.get('missing_sequences_before',0) for r in selected),
              'library_counter_deltas': counters, 'counter_scope': 'inside_window_endpoints_only',
              'edge_window_rule': 'clip_interval_and_prorate_reported_window_average',
              'first_observed_ns': selected[0]['sample']['receiver_observed_ns'] if selected else None,
              'last_observed_ns': selected[-1]['sample']['receiver_observed_ns'] if selected else None}
    seq_range = (selected[0]['sample']['seq'],selected[-1]['sample']['seq']) if selected else (0,0)
    return result, seq_range


def workload_audit(path):
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line]
    expected = [(cycle,event) for cycle in range(1,6)
                for event in ('browsed','edited','compile_started','compile_finished','run_started','run_returned')]
    preparation = bool(rows and rows[0]['event']=='prepared' and rows[0]['cycle']==0)
    actual = [(r['cycle'],r['event']) for r in rows[1:]]
    return {'completed': preparation and actual == expected and all(r['exit_code']==0 for r in rows if r['event']=='compile_finished'),
            'events': len(rows), 'sha256': digest(path), 'association': 'operator_review_and_cycle_order_not_clock_subtraction'}


def baseline(stats_path, stage_path, feedback_path, manifest_path, workload_path, context_path):
    manifest, feedback, context = (read_json(p) for p in (manifest_path,feedback_path,context_path))
    if manifest.get('schema') != 'lan-baseline-run-v1' or feedback.get('schema') != 'software-feedback-analysis-v1':
        raise ValueError('Unknown baseline/feedback schema')
    if context.get('schema') != 'lan-run-context-v1':
        raise ValueError('Unknown run context schema')
    for value in (feedback['samples'],):
        if any(r['session']!=manifest['session'] or r['experiment']!=manifest['experiment'] for r in value):
            raise ValueError('Feedback belongs to another experiment/session')
    if context['experiment'] != manifest['experiment'] or context['session'] != manifest['session']:
        raise ValueError('Run context belongs to another experiment/session')
    for name in ('controller','controlled_host','network','versions','artifact_sha256','workload_reviewer'):
        if not context.get(name):
            raise ValueError('Missing run context: '+name)
    start, finish = ns(manifest['start_ns']),ns(manifest['end_ns'])
    receiver, seq_range = statistics_window(stats_path,manifest)
    local = stages(stage_path,manifest['session'],seq_range)
    attempts = [r for r in feedback['samples'] if r['phase']=='formal'
                and start<=ns(r.get('start_ns') or r['armed_ns'])<=finish]
    cycle_counts = Counter((int((ns(r.get('start_ns') or r['armed_ns'])-start)//120_000_000_000)+1,r['category']) for r in attempts)
    workload = workload_audit(workload_path)
    criteria = {'continuous_600_seconds': finish-start == 600_000_000_000 and manifest.get('interrupted') is False,
                'five_fixed_cycles': workload['completed'] and context.get('workload_reviewed') is True,
                'four_attempts_per_cycle': cycle_counts == Counter({(c,g):1 for c in range(1,6) for g in GROUPS}),
                'all_attempts_reviewed': len(attempts)==20 and all(r.get('reviewer') for r in attempts),
                'statistics_available': receiver['valid_window_ms']>0,
                'stages_available': local['capture_count']>0}
    local_rows = [json.loads(line) for line in stage_path.read_text().splitlines() if line]
    dimensions = lambda a,b: sorted({(r.get(a),r.get(b)) for r in local_rows
        if r['event']=='capture' and r.get('session')==manifest['session']
        and seq_range[0]<=r.get('receiver_statistics_seq',0)<=seq_range[1]},key=str)
    source, submitted = dimensions('source_width','source_height'),dimensions('width','height')
    fps, bitrate = receiver['weighted_decoded_fps'],receiver['weighted_payload_kbps']
    target = {'decoded_720p': receiver['decoded_resolutions']==[(1280,720)],
              'submitted_720p': submitted==[(1280,720)], 'average_at_least_30_fps': fps is not None and fps>=30,
              'statistics_coverage': receiver['coverage_ratio']>=0.99,
              'no_reported_freezes': receiver['library_counter_deltas']['freezeCount']==0,
              'no_missing_sequences': receiver['missing_sequences']==0}
    category_values = {g:[r['observed_frame_latency_ms'] for r in attempts if r['category']==g and r['status']=='valid'] for g in GROUPS}
    references = {g:summary(values) for g,values in category_values.items()}
    result = {'schema':'lan-baseline-analysis-v1','experiment':manifest['experiment'],'session':manifest['session'],
              'collection_completed': all(criteria.values()),'collection_criteria':criteria,
              'target_720p30_reached':all(target.values()),'target_criteria':target,
              'target_rule':'720p submissions/decodes, average FPS >=30, coverage >=99%, no reported freeze/sequence loss',
              'physical_display_measurement':False,'measurement_enabled':True,'duration_seconds':(finish-start)/1e9,
              'receiver':receiver,'source_resolutions':source,'submitted_resolutions':submitted,
              'stages':local,'stage_association':'latest_delivered_receiver_sequence_approximation_not_clock_sync',
              'workload':workload,'context':context,'feedback_attempts':attempts,
              'feedback_statuses':dict(Counter(r['status'] for r in attempts)),'by_category':references,
              'next_experiment_defaults':{'feedback_reference_ms':{g:r['median_ms'] for g,r in references.items()},
                  'bandwidth_kbps':bitrate*.75 if bitrate is not None else None,'added_one_way_delay_ms':50,'random_loss_percent':1},
              'provenance':{str(p.name):digest(p) for p in (stats_path,stage_path,feedback_path,manifest_path,workload_path,context_path)}}
    return result


def overhead(off_path,on_path,off_window,on_window,feedback_path):
    off, on = read_json(off_window),read_json(on_window)
    for manifest,enabled in ((off,False),(on,True)):
        if manifest.get('schema')!='measurement-overhead-run-v1' or manifest.get('measurement_enabled') is not enabled:
            raise ValueError('Unknown overhead manifest or measurement mode')
        if ns(manifest['end_ns'])-ns(manifest['start_ns'])!=120_000_000_000:
            raise ValueError('Overhead runs must last 120 seconds')
    for name in ('workload_id','device_setup_id'):
        if not off.get(name) or off[name]!=on.get(name):
            raise ValueError('Overhead comparison conditions differ: '+name)
    feedback = read_json(feedback_path)
    if feedback.get('schema') != 'software-feedback-analysis-v1':
        raise ValueError('Unknown feedback schema')
    if any(r['session']!=on['session'] for r in feedback['samples']):
        raise ValueError('Overhead frames belong to another session')
    a,_=statistics_window(off_path,off);b,_=statistics_window(on_path,on)
    return {'schema':'measurement-overhead-analysis-v1','off':a,'on':b,
            'delta':{name:b[name]-a[name] if a[name] is not None and b[name] is not None else None
                     for name in ('weighted_decoded_fps','weighted_payload_kbps','weighted_mean_decode_ms')},
            'collector_processing':feedback['collector_processing'],'capture_gaps':feedback['capture_gaps'],
            'provenance':{role:digest(path) for role,path in
                (('off_statistics',off_path),('on_statistics',on_path),('off_window',off_window),
                 ('on_window',on_window),('on_feedback',feedback_path))}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    command=commands.add_parser('baseline')
    for name in ('statistics','stages','feedback','manifest','workload','context','output'):
        command.add_argument(name,type=Path)
    command=commands.add_parser('overhead')
    for name in ('off_statistics','on_statistics','off_window','on_window','feedback','output'):
        command.add_argument(name,type=Path)
    args=parser.parse_args()
    if args.command=='baseline':
        result=baseline(args.statistics,args.stages,args.feedback,args.manifest,args.workload,args.context)
    else:
        result=overhead(args.off_statistics,args.on_statistics,args.off_window,args.on_window,args.feedback)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'output':str(args.output)},ensure_ascii=False))


if __name__=='__main__':main()
