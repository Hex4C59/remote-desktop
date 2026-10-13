import json
from pathlib import Path
import tempfile
import unittest

import baseline
import software


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.start=9_000_000_000_000_000
        self.manifest=dict(schema='lan-baseline-run-v1',experiment='exp',session='session',clock='elapsedRealtimeNanos',
                           start_ns=str(self.start),end_ns=str(self.start+600_000_000_000),interrupted=False)
        self.context=dict(schema='lan-run-context-v1',experiment='exp',session='session',controller='test controller',
                          controlled_host='test host',network='test network',versions={'source':'test'},
                          artifact_sha256={'apk':'test'},workload_reviewer='test',workload_reviewed=True)
        self.rows=[dict(event='receiver_sample',missing_sequences_before=0,sample=dict(session='session',seq=i,
            receiver_observed_ns=str(self.start+i*2_000_000_000),receiver_window_ns='2000000000',state='sampled',
            decoded_fps=30,received_payload_kbps=1000,mean_decode_ms=1,
            raw=dict(frameWidth=1280,frameHeight=720,freezeCount=0))) for i in range(1,301)]
        self.feedback=dict(schema='software-feedback-analysis-v1',samples=[dict(experiment='exp',session='session',
            operation_id=str(c)+g,phase='formal',category=g,status='valid',reviewer='test',
            start_ns=str(self.start+(c-1)*120_000_000_000+(10+k*20)*1_000_000_000),
            observed_frame_latency_ms=25) for c in range(1,6) for k,g in enumerate(software.GROUPS)])
        self.audit=[dict(cycle=0,event='prepared',exit_code=0)]+[dict(cycle=c,event=e,exit_code=0) for c in range(1,6)
                    for e in ('browsed','edited','compile_started','compile_finished','run_started','run_returned')]
        self.local=[dict(schema='software-stages-v1',event='capture',session='session',receiver_statistics_seq=10,
                         outcome='fresh',capture_ns='100',source_width=1920,source_height=1080,width=1280,height=720),
                    dict(schema='software-stages-v1',event='stopped',write_failed=False,dropped_records_total=0)]

    def write(self,name,value):
        path=self.root/name
        if name.endswith('.jsonl'):path.write_text('\n'.join(json.dumps(r) for r in value)+'\n')
        else:path.write_text(json.dumps(value))
        return path

    def analyze(self):
        return baseline.baseline(self.write('stats.jsonl',self.rows),self.write('stages.jsonl',self.local),
            self.write('feedback.json',self.feedback),self.write('manifest.json',self.manifest),
            self.write('workload.jsonl',self.audit),self.write('context.json',self.context))

    def test_authorized_ai_review_is_separate_from_human_and_target(self):
        authority=dict(mode='user_authorized_ai_visual',requested_by='user',date='2026-10-13',instruction='Finish review')
        self.feedback.update(review_schema='software-review-v2',review_authorization=authority)
        for row in self.feedback['samples']:
            row.update(reviewer_kind='ai',rereviewer_kind='ai',rereviewer='test',rereviewed=True,rule='complete feedback')
        self.context.update(workload_reviewer_kind='ai',review_authorization=authority)
        self.feedback['samples'][0].update(status='incomplete',observed_frame_latency_ms=None)
        result=self.analyze()
        self.assertTrue(result['collection_completed'])
        self.assertEqual(result['review_counts'],{'ai':20})
        self.assertEqual(result['rereview_counts'],{'ai':20})
        self.assertEqual(result['by_category']['text_submit']['count'],4)
        self.context.pop('review_authorization')
        with self.assertRaises(ValueError):self.analyze()

    def test_v2_unreviewed_attempt_is_retained_without_completing_collection(self):
        self.feedback['review_schema']='software-review-v2'
        for row in self.feedback['samples']:
            row.update(reviewer_kind='human',rereviewer_kind='human',rereviewer='test',rereviewed=True,rule='complete feedback')
        row=self.feedback['samples'][0]
        for name in ('reviewer','reviewer_kind','rereviewer_kind','rereviewer','rereviewed','rule'):
            row.pop(name)
        row.update(status='unreadable',observed_frame_latency_ms=None)
        result=self.analyze()
        self.assertFalse(result['collection_completed'])
        self.assertEqual(len(result['feedback_attempts']),20)
        self.assertEqual(result['feedback_statuses']['unreadable'],1)

    def test_unknown_review_schema_rejected(self):
        self.feedback['review_schema']='unknown'
        with self.assertRaises(ValueError):self.analyze()

    def test_ai_feedback_without_matching_review_schema_rejected(self):
        self.feedback['samples'][0]['reviewer_kind']='ai'
        with self.assertRaises(ValueError):self.analyze()

    def test_complete_synthetic_run_and_separate_target(self):
        result=self.analyze()
        self.assertTrue(result['collection_completed']);self.assertTrue(result['target_720p30_reached'])
        self.assertEqual(result['next_experiment_defaults']['bandwidth_kbps'],750)
        self.assertEqual(result['source_resolutions'],[(1920,1080)])
        self.rows[10]['sample']['decoded_fps']=0;self.rows[10]['sample']['state']='no_new_decoded_frames'
        result=self.analyze()
        self.assertTrue(result['collection_completed']);self.assertFalse(result['target_720p30_reached'])
        self.assertLess(result['receiver']['weighted_decoded_fps'],30)

    def test_end_overlapping_freeze_is_included(self):
        self.rows.pop()
        last=dict(self.rows[-1]['sample'],seq=300,receiver_observed_ns=str(self.start+601_000_000_000),
                  receiver_window_ns='3000000000',decoded_fps=0,state='no_new_decoded_frames')
        self.rows.append(dict(event='receiver_sample',missing_sequences_before=0,sample=last))
        result=self.analyze()
        self.assertEqual(result['receiver']['weighted_decoded_fps'],29.9)
        self.assertEqual(result['receiver']['coverage_ratio'],1)
        self.assertFalse(result['target_720p30_reached'])

    def test_missing_or_duplicate_preparation_rejected(self):
        self.audit.pop(0)
        self.assertFalse(self.analyze()['collection_completed'])
        self.audit.insert(0,dict(cycle=0,event='prepared',exit_code=0))
        self.audit.insert(0,self.audit[0])
        self.assertFalse(self.analyze()['collection_completed'])

    def test_timer_and_category_counts_do_not_prove_workload(self):
        self.audit.pop()
        self.assertFalse(self.analyze()['collection_completed'])

    def test_cycle_distribution_is_checked(self):
        self.feedback['samples'][-1]['start_ns']=self.feedback['samples'][0]['start_ns']
        self.assertFalse(self.analyze()['collection_completed'])

    def test_interrupted_run_retained(self):
        self.manifest['end_ns']=str(self.start+120_000_000_000);self.manifest['interrupted']=True
        result=self.analyze();self.assertFalse(result['collection_completed'])
        self.assertEqual(len(result['feedback_attempts']),4)

    def test_another_session_rejected(self):
        self.rows[0]['sample']['session']='old'
        with self.assertRaises(ValueError):self.analyze()

    def test_duplicate_statistics_and_window_overlap_rejected(self):
        self.rows.insert(1,self.rows[0])
        with self.assertRaises(ValueError):self.analyze()
        self.rows.pop(1);self.rows[1]['sample']['receiver_window_ns']='3000000000'
        with self.assertRaises(ValueError):self.analyze()

    def test_actual_windows_weighted_and_empty_window_safe(self):
        self.rows=self.rows[:2];self.rows[0]['sample']['decoded_fps']=10
        self.rows[1]['sample']['receiver_window_ns']='1000000000';self.rows[1]['sample']['decoded_fps']=40
        self.assertEqual(self.analyze()['receiver']['weighted_decoded_fps'],20)
        self.rows=[]
        result=self.analyze();self.assertFalse(result['collection_completed'])
        self.assertIsNone(result['receiver']['weighted_payload_kbps'])

    def test_unexecuted_attempt_retained(self):
        value=self.feedback['samples'][0];value['armed_ns']=value['start_ns'];value['start_ns']=None;value['status']='not_run'
        self.assertEqual(self.analyze()['feedback_statuses']['not_run'],1)

    def test_overhead_comparison_rejects_changed_workload(self):
        off=dict(schema='measurement-overhead-run-v1',session='session',clock='elapsedRealtimeNanos',
                 start_ns=str(self.start),end_ns=str(self.start+120_000_000_000),measurement_enabled=False,
                 workload_id='fixed_cpp',device_setup_id='fixed_devices')
        on=dict(off,measurement_enabled=True)
        feedback=dict(self.feedback,collector_processing={},capture_gaps={})
        result=baseline.overhead(self.write('off.jsonl',self.rows),self.write('on.jsonl',self.rows),
            self.write('off-window.json',off),self.write('on-window.json',on),self.write('on-feedback.json',feedback))
        self.assertEqual(result['delta']['weighted_decoded_fps'],0)
        self.assertEqual(len(result['provenance']),5)
        on['workload_id']='changed'
        with self.assertRaises(ValueError):
            baseline.overhead(self.root/'off.jsonl',self.root/'on.jsonl',self.root/'off-window.json',
                self.write('on-window.json',on),self.root/'on-feedback.json')

    def test_foreign_experiment_rejected(self):
        self.feedback['samples'][0]['experiment']='old'
        with self.assertRaises(ValueError):self.analyze()


if __name__=='__main__':unittest.main()
