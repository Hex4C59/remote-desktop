import copy
import json
from pathlib import Path
import tempfile
import unittest
import zlib

import software


class FeedbackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sample = self.root / '0001'
        self.sample.mkdir()
        self.start = 9_000_000_000_000_000
        base = dict(schema='software-feedback-v1', experiment='experiment', session='session', operation_id='0001')
        rows = [dict(base, event='armed', category='text_submit', expected_feedback='complete text', phase='formal',
                     clock='elapsedRealtimeNanos', endpoint='VideoSink.onFrame_entry', armed_ns=str(self.start-1_000_000_000)),
                dict(base, event='action', start_ns=str(self.start), statistics_seq=7)]
        for frame_id, offset in ((1,-20_000_000),(2,30_000_000),(3,60_000_000)):
            name = f'frame-{frame_id}.i420.zlib'
            (self.sample/name).write_bytes(zlib.compress(bytes([frame_id])*6))
            rows.append(dict(base,event='frame',frame_id=frame_id,observed_ns=str(self.start+offset),
                             width=2,height=2,rotation=0,file=name,copy_ns='1',compress_ns='1',write_ns='1'))
        rows.append(dict(base,event='capture_end',status='captured'))
        self.rows = rows
        self.write()
        self.annotation = dict(base,index_sha256=software.digest(self.sample/'events.jsonl'),status='valid',
                               last_absent=1,first_present=2,reviewer='reviewer',rereviewer='reviewer',rule='complete text',rereviewed=True,
                               last_absent_sha256=software.digest(self.sample/'frame-1.i420.zlib'),
                               first_present_sha256=software.digest(self.sample/'frame-2.i420.zlib'))

    def write(self):
        (self.sample/'events.jsonl').write_text('\n'.join(json.dumps(r) for r in self.rows)+'\n')

    def analyze(self):
        return software.analyze(self.root,dict(schema='software-review-v1',samples=[self.annotation]))

    def ai_annotations(self):
        self.annotation.update(reviewer='codex', rereviewer='codex', reviewer_kind='ai', rereviewer_kind='ai')
        return dict(schema='software-review-v2', samples=[self.annotation], authorization=dict(
            mode='user_authorized_ai_visual', requested_by='user', date='2026-10-13', instruction='Please complete the review'))

    def test_authorized_ai_review_keeps_provenance_and_integer_difference(self):
        result = software.analyze(self.root, self.ai_annotations())
        row = result['samples'][0]
        self.assertEqual(result['boundary_review_counts'], {'ai': 1})
        self.assertEqual(result['boundary_rereview_counts'], {'ai': 1})
        self.assertTrue(row['same_reviewer_rereview'])
        self.assertFalse(row['same_person_rereview'])
        self.assertEqual(row['observed_frame_latency_ns'], '30000000')
        self.assertEqual(row['interval_ns'], ['0', '30000000'])

    def test_ai_review_cannot_hide_in_legacy_or_omit_user_delegation(self):
        annotations = self.ai_annotations()
        annotations.pop('authorization')
        with self.assertRaises(ValueError): software.analyze(self.root, annotations)
        annotations = self.ai_annotations(); annotations['schema'] = 'software-review-v1'
        with self.assertRaises(ValueError): software.analyze(self.root, annotations)
        annotations = self.ai_annotations(); self.annotation.pop('reviewer_kind')
        with self.assertRaises(ValueError): software.analyze(self.root, annotations)

    def test_ai_review_gap_retains_two_pass_boundary_but_no_valid_latency(self):
        self.rows.insert(-1,dict(self.rows[0],event='gap',observed_ns=str(self.start),reason='queue_overflow'))
        self.write();self.annotation['index_sha256']=software.digest(self.sample/'events.jsonl')
        result = software.analyze(self.root, self.ai_annotations())
        row = result['samples'][0]
        self.assertEqual(row['status'], 'incomplete')
        self.assertEqual(result['boundary_rereview_counts'], {'ai': 1})
        self.assertEqual(row['selected_boundary']['first_present'], 2)
        self.assertIsNone(row['observed_frame_latency_ms'])
        self.assertEqual(result['summary']['count'], 0)

    def test_formal_scope_keeps_other_attempts_and_rejects_foreign_identity(self):
        annotations = self.ai_annotations()
        second = self.root/'0002';second.mkdir()
        rows = [dict(r,operation_id='0002') for r in self.rows]
        (second/'events.jsonl').write_text('\n'.join(json.dumps(r) for r in rows)+'\n')
        for source in self.sample.glob('*.zlib'):
            (second/source.name).write_bytes(source.read_bytes())
        annotations['formal_scope'] = [{k:self.annotation[k] for k in ('experiment','session','operation_id')}]
        result = software.analyze(self.root,annotations)
        self.assertEqual(result['raw_formal_attempts'],2)
        self.assertEqual(result['formal_attempts'],1)
        self.assertEqual(len(result['samples']),2)
        self.assertEqual(result['formal_statuses'],{'valid':1})
        annotations['formal_scope'][0]['session']='old'
        with self.assertRaises(ValueError):software.analyze(self.root,annotations)

    def test_v2_exclusion_needs_both_review_passes(self):
        annotations = self.ai_annotations();self.annotation.update(status='excluded',reason='method check',rereviewed=False)
        with self.assertRaises(ValueError): software.analyze(self.root, annotations)

    def test_integer_clock_and_preroll_interval(self):
        row = self.analyze()['samples'][0]
        self.assertEqual(row['observed_frame_latency_ms'],30)
        self.assertEqual(row['interval_ms'],[0,30])

    def test_boundary_gap_is_not_valid_latency(self):
        self.rows.insert(-1,dict(self.rows[0],event='gap',observed_ns=str(self.start),reason='queue_overflow'))
        self.write();self.annotation['index_sha256']=software.digest(self.sample/'events.jsonl')
        result=self.analyze()
        self.assertEqual(result['samples'][0]['status'],'incomplete')
        self.assertEqual(result['summary']['count'],0)

    def test_non_adjacent_boundary_rejected(self):
        self.annotation['first_present']=3
        self.annotation['first_present_sha256']=software.digest(self.sample/'frame-3.i420.zlib')
        with self.assertRaises(ValueError):self.analyze()

    def test_old_session_cannot_annotate_new_capture(self):
        self.annotation['session']='old'
        with self.assertRaises(ValueError):self.analyze()

    def test_changed_frame_cannot_be_reviewed(self):
        (self.sample/'frame-2.i420.zlib').write_bytes(zlib.compress(b'xxxxxx'))
        with self.assertRaises(ValueError):self.analyze()

    def test_failure_cannot_be_promoted_by_review(self):
        self.rows[-1]['status']='send_failed';self.write()
        self.annotation['index_sha256']=software.digest(self.sample/'events.jsonl')
        with self.assertRaises(ValueError):self.analyze()

    def test_timeout_retained_in_denominator(self):
        self.annotation.update(status='timeout',reason='No expected feedback in five seconds')
        result=self.analyze()
        self.assertEqual(result['formal_attempts'],1)
        self.assertEqual(result['formal_statuses'],{'timeout':1})
        self.assertIsNone(result['summary']['median_ms'])

    def test_pixels_size_and_trailing_data_checked(self):
        p=self.sample/'frame-1.i420.zlib'
        self.assertEqual(len(software.pixels(p,2,2)),6)
        p.write_bytes(p.read_bytes()+b'trailing')
        with self.assertRaises(ValueError):software.pixels(p,2,2)

    def test_unreviewed_frames_never_generate_measurements(self):
        result=software.analyze(self.root,dict(schema='software-review-v1',samples=[]))
        self.assertEqual(result['summary']['count'],0)

    def test_send_failure_retained_without_annotation(self):
        self.rows[-1]['status']='send_failed';self.write()
        result=software.analyze(self.root,dict(schema='software-review-v1',samples=[]))
        self.assertEqual(result['formal_statuses'],{'send_failed':1})

    def test_unknown_clock_rejected(self):
        self.rows[0]['clock']='wall_clock';self.write()
        with self.assertRaises(ValueError):self.analyze()

    def test_duplicate_review_and_unsafe_path_rejected(self):
        with self.assertRaises(ValueError):
            software.analyze(self.root,dict(schema='software-review-v1',samples=[self.annotation]*2))
        self.rows[2]['file']='../escape.i420.zlib';self.write()
        with self.assertRaises(ValueError):self.analyze()


if __name__=='__main__':unittest.main()
