#!/usr/bin/env python3
"""Reproduce software observations from same-clock records and reviewed frames."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import zlib

STATUSES = {'valid', 'send_failed', 'timeout', 'unreadable', 'incomplete',
            'session_ended', 'not_run', 'excluded'}
GROUPS = ('text_submit', 'compile_start', 'program_start', 'interrupt_return')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ns(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdigit():
        raise ValueError('Nanosecond values must be decimal strings')
    number = int(value)
    if number > 2**63 - 1:
        raise ValueError('Timestamp exceeds signed 64-bit range')
    return number


def load_sample(directory):
    index = directory / 'events.jsonl'
    rows = [json.loads(line) for line in index.read_text().splitlines() if line.strip()]
    if not rows or any(row.get('schema') != 'software-feedback-v1' for row in rows):
        raise ValueError('Unknown or empty feedback schema')
    identities = {(r['experiment'], r['session'], r['operation_id']) for r in rows}
    if len(identities) != 1:
        raise ValueError('Mixed operation/session identities')
    armed = [r for r in rows if r['event'] == 'armed']
    actions = [r for r in rows if r['event'] == 'action']
    endings = [r for r in rows if r['event'] == 'capture_end']
    if len(armed) != 1 or len(actions) > 1 or len(endings) > 1:
        raise ValueError('Duplicate action or lifecycle records')
    if armed[0].get('clock') != 'elapsedRealtimeNanos' or armed[0].get('endpoint') != 'VideoSink.onFrame_entry':
        raise ValueError('Unrecognized clock or endpoint')
    frames = sorted((r for r in rows if r['event'] == 'frame'), key=lambda r: ns(r['observed_ns']))
    if len({r['frame_id'] for r in frames}) != len(frames):
        raise ValueError('Duplicate frame identity')
    for frame in frames:
        name = frame['file']
        if Path(name).name != name or not name.startswith('frame-') or not name.endswith('.i420.zlib'):
            raise ValueError('Unsafe evidence file name')
        if not (0 < frame['width'] <= 4096 and 0 < frame['height'] <= 4096):
            raise ValueError('Invalid dimensions')
        frame['sha256'] = digest(directory / name)
    return {'directory': directory, 'index_sha256': digest(index), 'armed': armed[0],
            'action': actions[0] if actions else None, 'end': endings[0] if endings else None,
            'frames': frames, 'gaps': [r for r in rows if r['event'] == 'gap'],
            'fatal': (directory / 'failure.json').exists()}


def samples(directory):
    return [load_sample(path.parent) for path in sorted(directory.glob('*/events.jsonl'))]


def summary(values):
    return {'count': len(values), 'median_ms': statistics.median(values) if values else None,
            'min_ms': min(values) if values else None, 'max_ms': max(values) if values else None}


def analyze(directory, annotations):
    if annotations.get('schema') != 'software-review-v1':
        raise ValueError('Unknown annotation schema')
    chosen = {}
    for row in annotations['samples']:
        key = (row['experiment'], row['session'], row['operation_id'])
        if key in chosen:
            raise ValueError('Duplicate annotations')
        chosen[key] = row
    output = []
    evidence = samples(directory)
    for sample in evidence:
        armed = sample['armed']
        key = (armed['experiment'], armed['session'], armed['operation_id'])
        annotation = chosen.pop(key, None)
        result = {**{k: armed[k] for k in ('experiment', 'session', 'operation_id', 'category', 'phase')},
                  'index_sha256': sample['index_sha256'], 'status': 'unreadable',
                  'observed_frame_latency_ms': None, 'interval_ms': None,
                  'start_ns': sample['action']['start_ns'] if sample['action'] else None,
                  'armed_ns': armed['armed_ns']}
        if not annotation:
            lifecycle = (sample['end'] or {}).get('status')
            if lifecycle in {'send_failed', 'session_ended', 'not_run'}:
                result['status'] = lifecycle
            elif sample['fatal'] or lifecycle not in {None, 'captured'}:
                result['status'] = 'incomplete'
            result['reason'] = 'Not reviewed; capture lifecycle retained'
            output.append(result)
            continue
        if annotation['index_sha256'] != sample['index_sha256']:
            raise ValueError('Evidence index changed since review')
        status = annotation['status']
        if status not in STATUSES:
            raise ValueError('Unknown review status')
        result.update(status=status, reason=annotation.get('reason', ''), reviewer=annotation.get('reviewer', ''))
        end_status = (sample['end'] or {}).get('status')
        if status == 'valid':
            if end_status != 'captured' or sample['fatal'] or not sample['action']:
                raise ValueError('Incomplete/failed capture cannot be valid')
            if not annotation.get('reviewer') or not annotation.get('rule') or not annotation.get('rereviewer') or annotation.get('rereviewed') is not True:
                raise ValueError('Valid observations need rule, reviewer and repeated review')
            frame_map = {r['frame_id']: r for r in sample['frames']}
            before = frame_map[annotation['last_absent']]
            after = frame_map[annotation['first_present']]
            if annotation.get('last_absent_sha256') != before['sha256'] or annotation.get('first_present_sha256') != after['sha256']:
                raise ValueError('Boundary frame changed since review')
            start = ns(sample['action']['start_ns'])
            low, high = ns(before['observed_ns']), ns(after['observed_ns'])
            if low >= high or high < start or high > start + 5_000_000_000:
                raise ValueError('Invalid feedback time ordering/window')
            if any(low < ns(frame['observed_ns']) < high for frame in sample['frames']):
                raise ValueError('Boundary frames must be consecutive observations')
            if any(low <= ns(gap['observed_ns']) <= high for gap in sample['gaps']):
                result.update(status='incomplete', reason='Frame gap intersects feedback boundary')
            elif before['width'] != after['width'] or before['height'] != after['height'] or before['rotation'] != after['rotation']:
                result.update(status='incomplete', reason='Frame geometry changed at boundary')
            else:
                result['observed_frame_latency_ms'] = (high - start) / 1_000_000
                result['interval_ms'] = [max(0, low - start) / 1_000_000, (high - start) / 1_000_000]
                result['statistics_seq'] = sample['action']['statistics_seq']
                result['rule'] = annotation['rule']
                result['rereviewed'] = True
                result['rereviewer'] = annotation['rereviewer']
                result['same_person_rereview'] = annotation['reviewer'] == annotation['rereviewer']
        elif not result['reason']:
            raise ValueError('Non-valid attempt needs a reason')
        # Send failure and lifecycle termination are facts, not review choices.
        if end_status in {'send_failed', 'session_ended', 'not_run'} and result['status'] != end_status:
            raise ValueError('Annotation contradicts capture lifecycle')
        output.append(result)
    if chosen:
        raise ValueError('Annotations reference another experiment/session/operation')
    formal = [r for r in output if r['phase'] == 'formal']
    groups = defaultdict(list)
    for row in formal:
        if row['status'] == 'valid':
            groups[row['category']].append(row['observed_frame_latency_ms'])
    return {'schema': 'software-feedback-analysis-v1', 'endpoint': 'VideoSink.onFrame_entry',
            'physical_display_measurement': False, 'measurement_enabled': True, 'samples': output,
            'collector_processing': {name: summary([ns(frame[name])/1_000_000
                for sample in evidence for frame in sample['frames']])
                for name in ('copy_ns', 'compress_ns', 'write_ns')},
            'capture_gaps': dict(Counter(gap['reason'] for sample in evidence for gap in sample['gaps'])),
            'formal_attempts': len(formal), 'formal_statuses': dict(Counter(r['status'] for r in formal)),
            'by_category': {name: summary(values) for name, values in groups.items()},
            'summary': summary([r['observed_frame_latency_ms'] for r in formal if r['status'] == 'valid'])}


def pixels(path, width, height):
    expected = width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
    if expected > 4 * 1024 * 1024:
        raise ValueError('Image exceeds collector limit')
    decoder = zlib.decompressobj()
    data = decoder.decompress(path.read_bytes(), expected + 1)
    if len(data) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('Invalid compressed I420 frame')
    return data


def review(directory, destination):
    destination.mkdir(parents=True, exist_ok=False)
    catalog = []
    for sample in samples(directory):
        row = dict(sample['armed'])
        row.update(index_sha256=sample['index_sha256'], action=sample['action'], end=sample['end'], frames=[], gaps=sample['gaps'])
        previous = None
        for number, frame in enumerate(sample['frames']):
            image = pixels(sample['directory'] / frame['file'], frame['width'], frame['height'])
            luma = image[:frame['width'] * frame['height']:max(1, frame['width'] * frame['height'] // 14400)]
            delta = sum(abs(a-b) for a,b in zip(luma, previous)) / len(luma) if previous is not None and len(luma) == len(previous) else 0
            previous = luma
            name = f"{row['operation_id']}-{number:04}.png"
            filters = {0: [], 90: ['transpose=1'], 180: ['hflip,vflip'], 270: ['transpose=2']}
            if frame['rotation'] not in filters:
                raise ValueError('Unsupported rotation')
            command = ['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'yuv420p',
                       '-video_size', f"{frame['width']}x{frame['height']}", '-i', 'pipe:0', '-frames:v', '1']
            if filters[frame['rotation']]:
                command.extend(['-vf', filters[frame['rotation']][0]])
            subprocess.run(command + [str(destination / name)], input=image, check=True)
            row['frames'].append({**frame, 'image': name, 'candidate': delta >= 1, 'luma_delta': delta})
        catalog.append(row)
    data = json.dumps(catalog, ensure_ascii=False).replace('<', '\\u003c')
    html = REVIEW_HTML.replace('__CATALOG__', data)
    (destination / 'index.html').write_text(html)
    return {'samples': len(catalog), 'review_page': str((destination / 'index.html').resolve())}


REVIEW_HTML = '''<!doctype html><html lang="zh"><meta charset="utf-8"><title>软件反馈帧复核</title>
<style>body{font:16px system-ui;margin:24px;background:#18202a;color:#eef1f5}input,select,button{font:inherit;margin:5px;padding:6px}img{max-width:100%;max-height:65vh}#slider{width:90%}textarea{width:90%;height:55px}small{color:#b6c4d7}</style>
<h1>软件反馈帧复核</h1><p>逐帧确认完整预期反馈。变化候选仅供导览；保留失败和缺口。时间终点是收到视频帧的回调入口。</p>
<select id="sample"></select><span id="description"></span><p id="details"></p>
<img id="image"><p id="frame"></p><input id="slider" type="range" min="0" value="0">
<div><button id="prev">上一帧</button><button id="next">下一帧</button><button id="candidate">下个变化候选</button></div>
<div><button id="absent">最后无反馈</button><button id="present">最早完整反馈</button><span id="bounds"></span></div>
<select id="status"><option>unreadable</option><option>valid</option><option>timeout</option><option>incomplete</option><option>send_failed</option><option>session_ended</option><option>not_run</option><option>excluded</option></select>
<input id="reviewer" placeholder="复核者"><input id="rereviewer" placeholder="复读者（同人填写相同名字）"><input id="rule" placeholder="完整反馈判据"><label><input id="rereview" type="checkbox">已复读边界</label><p><textarea id="reason" placeholder="失败、排除或不可判读原因"></textarea></p>
<button id="save">保存本样本选择</button><button id="export">导出复核 JSON</button><input id="import" type="file" accept="application/json"><p id="notice"></p>
<script>const catalog=__CATALOG__, records=new Map(); const key=r=>JSON.stringify([r.experiment,r.session,r.operation_id]); const $=id=>document.getElementById(id);let current,before,after;
for(let i=0;i<catalog.length;i++){const o=document.createElement('option');o.value=i;o.textContent=catalog[i].operation_id+' '+catalog[i].category;$('sample').append(o)}
function show(){current=catalog[+$('sample').value];if(!current)return;before=after=null;$('description').textContent=current.expected_feedback;
$('details').textContent='会话 '+current.session+' · '+current.phase+' · 缺口 '+current.gaps.length+' · '+(current.end?.status||'未结束');$('slider').max=Math.max(0,current.frames.length-1);$('slider').value=0;
const saved=records.get(key(current));$('status').value=saved?.status||'unreadable';$('reviewer').value=saved?.reviewer||'';$('rereviewer').value=saved?.rereviewer||'';$('rule').value=saved?.rule||'';$('reason').value=saved?.reason||'';$('rereview').checked=saved?.rereviewed||false;before=saved?.last_absent;after=saved?.first_present;draw()}
function draw(){const f=current?.frames[+$('slider').value];$('image').src=f?.image||'';$('frame').textContent=f?('帧 '+f.frame_id+' · '+f.observed_ns+' ns · '+(current.action?Number(BigInt(f.observed_ns)-BigInt(current.action.start_ns))/1e6:'未发送')+' ms · 变化值 '+f.luma_delta.toFixed(2)):'没有可判读帧';$('bounds').textContent='无反馈 '+(before??'未选')+' → 完整反馈 '+(after??'未选')}
$('sample').onchange=show;$('slider').oninput=draw;$('prev').onclick=()=>{$('slider').value=Math.max(0,+$('slider').value-1);draw()};$('next').onclick=()=>{$('slider').value=Math.min(+$('slider').max,+$('slider').value+1);draw()};$('candidate').onclick=()=>{for(let i=+$('slider').value+1;i<current.frames.length;i++)if(current.frames[i].candidate){$('slider').value=i;break}draw()};
$('absent').onclick=()=>{before=current.frames[+$('slider').value]?.frame_id;draw()};$('present').onclick=()=>{after=current.frames[+$('slider').value]?.frame_id;draw()};
$('save').onclick=()=>{const frames=new Map(current.frames.map(f=>[f.frame_id,f]));records.set(key(current),{experiment:current.experiment,session:current.session,operation_id:current.operation_id,index_sha256:current.index_sha256,status:$('status').value,last_absent:before,first_present:after,last_absent_sha256:frames.get(before)?.sha256,first_present_sha256:frames.get(after)?.sha256,reviewer:$('reviewer').value,rereviewer:$('rereviewer').value,rule:$('rule').value,reason:$('reason').value,rereviewed:$('rereview').checked});$('notice').textContent='已保存选择；导出文件后才写入磁盘'};
$('export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({schema:'software-review-v1',samples:[...records.values()]},null,2)],{type:'application/json'}));a.download='software-review.json';a.click();URL.revokeObjectURL(a.href)};
$('import').onchange=async()=>{try{
  const data=JSON.parse(await $('import').files[0].text());
  if(data.schema!=='software-review-v1'||!Array.isArray(data.samples))throw Error('Unknown review format');
  const evidence=new Map(catalog.map(s=>[key(s),s])),accepted=new Map();
  for(const r of data.samples){
    const source=evidence.get(key(r));
    if(!source||source.index_sha256!==r.index_sha256||accepted.has(key(r)))throw Error('Review identity/index mismatch');
    if(r.status==='valid'&&(r.last_absent===undefined||r.first_present===undefined||!r.last_absent_sha256||!r.first_present_sha256))throw Error('Valid review needs two hashed boundaries');
    const frames=new Map(source.frames.map(f=>[f.frame_id,f]));
    for(const [id,hash] of [[r.last_absent,r.last_absent_sha256],[r.first_present,r.first_present_sha256]]){
      if(id!==undefined&&(!frames.has(id)||frames.get(id).sha256!==hash))throw Error('Boundary evidence mismatch');
    }
    accepted.set(key(r),r);
  }
  for(const [id,r] of accepted)records.set(id,r);show();$('notice').textContent='Imported matching evidence only';
}catch(error){$('notice').textContent='Import rejected: '+error.message}};show();</script></html>'''


def stages(path, session=None, sequence_range=None):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    if any(r.get('schema') != 'software-stages-v1' for r in rows):
        raise ValueError('Unknown stage schema')
    captures = [r for r in rows if r['event'] == 'capture'
                and (session is None or r.get('session') == session)
                and (sequence_range is None or sequence_range[0] <= r.get('receiver_statistics_seq', 0) <= sequence_range[1])]
    metrics = {}
    for field in ('capture_ns', 'acquire_ns', 'readback_ns', 'convert_ns', 'rotate_ns', 'scale_ns', 'submit_ns', 'total_ns'):
        metrics[field] = summary([ns(r[field]) / 1_000_000 for r in captures if r.get(field) is not None])
    end = next((r for r in reversed(rows) if r['event'] == 'stopped'), None)
    return {'schema': 'software-stage-analysis-v1', 'source_sha256': digest(path),
            'outcomes': dict(Counter(r['outcome'] for r in captures)),
            'acquire_statuses': dict(Counter(r.get('acquire_status','unknown') for r in captures)), 'stages': metrics,
            'complete_log': bool(end and not end.get('write_failed') and end.get('dropped_records_total') == 0),
            'end': end, 'capture_count': len(captures),
            'bottlenecks': sorted(({'stage': name, **value} for name,value in metrics.items()
                if name not in {'capture_ns','total_ns'} and value['median_ms'] is not None),
                key=lambda value: value['median_ms'], reverse=True)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name, args in [('review', ('directory','output')), ('analyze', ('directory','annotations','output')),
                       ('stages', ('log','output'))]:
        sub = commands.add_parser(name)
        for name in args:
            sub.add_argument(name, type=Path)
    args = parser.parse_args()
    if args.command == 'review': result = review(args.directory, args.output)
    elif args.command == 'analyze': result = analyze(args.directory, json.loads(args.annotations.read_text()))
    elif args.command == 'stages': result = stages(args.log)
    if args.command != 'review': args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result if args.command=='review' else {'output':str(args.output)},ensure_ascii=False))


if __name__ == '__main__':
    main()
