#!/usr/bin/env python3
"""Recompute short, independent impaired-network experiments from local evidence."""
import argparse
from collections import Counter
import ipaddress
import json
from pathlib import Path
import statistics

from baseline import statistics_window
from software import GROUPS, analyze, digest, ns, stages

MODES = ('pass', 'rate', 'delay', 'loss')
PARAMETERS = {'rate_bps_per_direction': 116093, 'delay_ns_per_direction': '50000000',
              'loss_probability_per_direction': .01, 'loss_seed': 20261013,
              'rate_accounting': 'IP_packet_bytes', 'random_algorithm': 'xorshift64star-v1'}


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def lines(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def bundle(lines_):
    groups, sections, kind = [], {}, None
    for line in lines_:
        if line.startswith('a=group:BUNDLE '):
            groups.append(line.split()[1:])
        elif line.startswith('m='):
            kind = line[2:].split()[0]
        elif line.startswith('a=mid:'):
            sections[line[6:]] = kind
    return any({'video', 'application'} <= {sections.get(mid) for mid in group} for group in groups)


def route(sample):
    selected = [t['selected'] for t in sample.get('transport', {}).get('transports', []) if 'selected' in t]
    if len(selected) != 1:
        return None
    endpoints = []
    for side in ('remote', 'local'):  # Windows endpoint first; receiver's remote candidate.
        value = selected[0].get(side, {})
        if value.get('protocol') != 'udp' or not isinstance(value.get('port'), int):
            return None
        address = value.get('address') or value.get('ip')
        try:
            address = str(ipaddress.IPv4Address(address))
        except (ipaddress.AddressValueError, TypeError):
            return None
        if not 0 < value['port'] <= 65535:
            return None
        endpoints.extend((address, value['port']))
    return tuple(endpoints)


def run_events(path, experiment, session):
    records = lines(path)
    phases = {}
    for row in records:
        if (row.get('schema') != 'impaired-run-events-v1' or row.get('clock') != 'elapsedRealtimeNanos'
                or row.get('experiment') != experiment or row.get('session') != session):
            raise ValueError('Mixed run identity, schema or clock')
        if row['event'] == 'receiver_sample' and row['sample'].get('session') != session:
            raise ValueError('Old receiver sample in new session')
        if row['event'] == 'phase':
            name = row['phase']
            if name in phases:
                raise ValueError('Duplicate experiment phase')
            phases[name] = ns(row['observed_ns'])
    return records, phases


def window(phases, start_name, end_name, seconds, session, records):
    if start_name not in phases:
        return None
    start = phases[start_name]
    ends = [ns(r['observed_ns']) for r in records if r['event'] == 'session_ended']
    stop = phases.get(end_name, ends[-1] if ends else start)
    if stop <= start:
        return None
    finish = min(start + seconds * 1_000_000_000, stop)
    return dict(session=session, clock='elapsedRealtimeNanos', start_ns=str(start), end_ns=str(finish),
                planned_seconds=seconds, completed=stop >= start + seconds * 1_000_000_000)


def recovery_interval(request_ns, confirmed_ns, feedback_ns):
    request, confirmed, feedback = map(ns, (request_ns, confirmed_ns, feedback_ns))
    if confirmed < request or feedback < request:
        raise ValueError('Recovery clock ordering invalid')
    return [max(0, feedback-confirmed), feedback-request]


def trace_report(path, experiment, session, mode):
    rows = lines(path)
    if not rows or any(r.get('schema') != 'network-shaper-trace-v1' or r.get('experiment') != experiment
                       or r.get('session') != session or r.get('clock') != 'QueryPerformanceCounter_ns' for r in rows):
        raise ValueError('Wrong shaper identity/schema/clock')
    for row in rows:
        ns(row['observed_ns'])
    activation = next((r for r in rows if r['event'] == 'profile_applied' and r.get('epoch') == '1'), None)
    clear = next((r for r in rows if r['event'] == 'profile_applied' and r.get('epoch') == '2'), None)
    if activation and activation.get('profile') != mode:
        raise ValueError('Shaper applied a different factor')
    begin = ns(activation['observed_ns']) if activation else None
    finish = ns(clear['observed_ns']) if clear else None
    packets = [r for r in rows if r['event'] == 'packet']
    ids = [p['packet_id'] for p in packets]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate shaper packet')
    active = [p for p in packets if (p.get('epoch') == '1' if 'epoch' in p else
              begin is not None and ns(p['captured_ns']) >= begin and (finish is None or ns(p['captured_ns']) < finish))]
    by_direction = {}
    for direction in ('down', 'up'):
        values = [p for p in active if p['direction'] == direction]
        sent = [p for p in values if p['result'] == 'sent']
        waits = [(ns(p['observed_ns'])-ns(p['captured_ns']))/1_000_000 for p in sent]
        if any(ns(p['observed_ns']) < ns(p['due_ns']) for p in sent):
            raise ValueError('Packet sent before its scheduled deadline')
        if mode == 'delay' and any(ns(p['due_ns'])-ns(p['captured_ns']) < 50_000_000 for p in sent):
            raise ValueError('Configured delay was not applied')
        counts = Counter(p['result'] for p in values)
        by_direction[direction] = dict(captured_packets=len(values), results=dict(counts),
            sent_IP_bytes=sum(p['bytes'] for p in sent),
            actual_random_drop_ratio=counts['random_drop']/len(values) if values else None,
            queue_wait_median_ms=statistics.median(waits) if waits else None,
            queue_wait_max_ms=max(waits) if waits else None)
    complete = rows[-1]['event'] == 'stopped' and not rows[-1].get('receive_failed', True)
    return dict(source_sha256=digest(path), complete=complete,
                actual_active_seconds=(finish-begin)/1e9 if begin is not None and finish is not None else None,
                both_directions_observed=all(v['captured_packets'] for v in by_direction.values()),
                directions=by_direction, boundary='WinDivert capture to synchronous injection return',
                unobserved_kernel_or_link_drops='not inferred from the application packet ledger')


def planned_attempts(feedback, start, finish, experiment, session):
    selected = []
    for row in feedback['samples']:
        if row['experiment'] != experiment or row['session'] != session:
            raise ValueError('Old feedback operation in a new experiment')
        if row['phase'] == 'formal' and row['category'] in GROUPS and (row.get('start_ns') is None
                or start <= ns(row['start_ns']) < finish):
            selected.append(row)
    for group in GROUPS:
        matches = [s for s in selected if s['category'] == group]
        if len(matches) > 1:
            raise ValueError('More than one formal attempt per category in short protocol')
        if not matches:
            selected.append(dict(operation_id=None, category=group, status='not_run', reason='No attempt in selected window'))
    return selected


def run(config, root):
    mode = config['mode']
    if mode not in MODES:
        raise ValueError('Unknown independent condition')
    if config.get('not_executed_reason'):
        return dict(mode=mode, collection_completed=False, path_verified=False,
                    feedback_attempts=[dict(category=g, status='not_run', reason=config['not_executed_reason']) for g in GROUPS])
    def path(name):
        return (root / config[name]).resolve()
    experiment, session = config['experiment'], config['session']
    directory = path('directory')
    records, phases = run_events(directory/'run.jsonl', experiment, session)
    log_status = read(directory/'run-log-status.json')
    if log_status.get('experiment') != experiment or log_status.get('session') != session:
        raise ValueError('Wrong local log closure identity')
    feedback = analyze(directory, read(path('annotations')))
    first, last = ('normal_start', 'normal_end') if mode == 'pass' else ('impairment_start', 'impairment_end')
    selected = window(phases, first, last, 120, session, records)
    windows = {}
    for name, a, b, duration in [('normal', 'normal_start', 'normal_end', 120 if mode == 'pass' else 60),
                                ('impaired', 'impairment_start', 'impairment_end', 120),
                                ('recovery', 'clear_confirmed', 'recovery_end', 60)]:
        interval = window(phases,a,b,duration,session,records)
        if interval:
            stats, seq_range = statistics_window(directory/'run.jsonl', interval)
            windows[name] = dict(window=interval, statistics=stats, stages=stages(path('stages'),session,seq_range))
    start, finish = (ns(selected['start_ns']), ns(selected['end_ns'])) if selected else (0, 2**63-1)
    attempts = planned_attempts(feedback,start,finish,experiment,session)
    proof = read(path('path_proof'))
    if proof.get('experiment') != experiment or proof.get('session') != session:
        raise ValueError('Wrong path-verification identity')
    tuples = [route(r['sample']) for r in records if r['event']=='receiver_sample'
              and start <= ns(r['sample']['receiver_observed_ns']) <= finish]
    expected = tuple(proof['windows_receiver_tuple'])
    consistent = bool(tuples) and all(value == expected for value in tuples)
    negotiations = [r for r in records if r['event']=='negotiation']
    negotiated = len(negotiations)==1 and all(bundle(negotiations[0][side]) for side in ('local','remote'))
    injected = trace_report(path('trace'),experiment,session,mode)
    verified = consistent and negotiated and proof.get('owner_verified') is True and injected['both_directions_observed']
    recovery = dict(same_session_recovered=False, manually_reconnected=bool(config.get('manual_reconnect')))
    if 'clear_requested' in phases and 'clear_confirmed' in phases:
        candidates=[s for s in feedback['samples'] if s['category']=='recovery' and s['status']=='valid'
                    and ns(s['start_ns']) >= phases['clear_confirmed']]
        stats=[r['sample'] for r in records if r['event']=='receiver_sample' and
               phases['clear_confirmed'] <= ns(r['sample']['receiver_observed_ns']) <= phases['clear_confirmed']+60_000_000_000]
        streak=0
        for sample in stats:
            if sample['state']=='sampled' and sample.get('decoded_fps',0)>0:
                streak+=ns(sample['receiver_window_ns'])
            else:
                streak=0
            if streak>=10_000_000_000:break
        if candidates:
            sample=candidates[0]
            feedback_ns=sample['selected_boundary']['first_present_ns']
            recovery.update(operation_id=sample['operation_id'], interval_ns=[str(v) for v in recovery_interval(
                str(phases['clear_requested']),str(phases['clear_confirmed']),feedback_ns)],
                same_session_recovered=streak>=10_000_000_000)
        recovery['ten_seconds_new_decoded_frames']=streak>=10_000_000_000
    audited=read(path('workload_review'))
    if audited.get('experiment') != experiment or audited.get('session') != session:
        raise ValueError('Wrong workload-review identity')
    complete = bool(selected and selected['completed'] and verified and injected['complete']
        and not log_status['write_failed'] and log_status['dropped_records']==0
        and audited.get('workload_reviewed') is True and all(s.get('rereviewed') is True or s['status']=='not_run' for s in attempts)
        and all(s['status']!='not_run' for s in attempts))
    return dict(mode=mode,experiment=experiment,session=session,collection_completed=complete,
                path_verified=verified,route_consistent=consistent,bundle_verified=negotiated,
                windows=windows,shaper=injected,feedback_attempts=attempts,
                feedback_statuses=dict(Counter(s['status'] for s in attempts)),recovery=recovery,
                review_authorization=feedback.get('review_authorization'),
                review_counts=feedback.get('boundary_review_counts'),rereview_counts=feedback.get('boundary_rereview_counts'),
                capture_gaps=feedback['capture_gaps'],local_log_status=log_status,
                source_sha256={name:digest(path(name)) for name in ('annotations','stages','trace','path_proof','workload_review')},
                local_statistics_sha256=digest(directory/'run.jsonl'),
                stage_alignment='latest delivered receiver statistics sequence; weak-network delivery can lag')


def report(manifest):
    source=read(manifest)
    if source.get('schema')!='impaired-network-suite-v1':
        raise ValueError('Unknown suite schema')
    configs=source['runs']
    if len({r['mode'] for r in configs})!=len(configs):
        raise ValueError('Repeated condition in suite')
    identities=[(r['experiment'],r['session']) for r in configs if not r.get('not_executed_reason')]
    if len(set(identities))!=len(identities) or len({s for _,s in identities})!=len(identities):
        raise ValueError('Experiments must use distinct sessions')
    results=[run(r,manifest.parent) for r in configs]
    weak=[r for r in results if r['mode']!='pass']
    return dict(schema='impaired-network-report-v1',source_sha256=digest(manifest),parameters=PARAMETERS,
                collection_completed={r['mode'] for r in results}==set(MODES) and all(r['collection_completed'] for r in results),
                planned_formal_weak_attempts=12,runs=results,
                formal_weak_statuses=dict(Counter(s['status'] for r in weak for s in r['feedback_attempts'])),
                physical_display_measurement=False,sample_limit='one attempt per operation and condition; no statistical inference')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['report']);parser.add_argument('manifest',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args()
    result=report(args.manifest)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'output':str(args.output),'collection_completed':result['collection_completed']}))

if __name__=='__main__':main()
