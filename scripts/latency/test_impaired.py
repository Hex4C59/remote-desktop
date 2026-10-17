import json
from pathlib import Path
import tempfile
import unittest
import impaired

class ImpairedTests(unittest.TestCase):
    def test_recovery_interval_uses_same_clock_and_retains_uncertainty(self):
        self.assertEqual(impaired.recovery_interval('100','130','180'),[50,80])
        self.assertEqual(impaired.recovery_interval('100','190','180'),[0,80])
        with self.assertRaises(ValueError):impaired.recovery_interval('100','90','180')
        with self.assertRaises(ValueError):impaired.recovery_interval(100,'130','180')

    def test_bundle_requires_video_and_data_in_same_group(self):
        s=['a=group:BUNDLE 0 1','m=video 9 UDP/TLS/RTP/SAVPF 96','a=mid:0',
           'm=application 9 UDP/DTLS/SCTP webrtc-datachannel','a=mid:1']
        self.assertTrue(impaired.bundle(s))
        self.assertFalse(impaired.bundle(['a=group:BUNDLE 0']+s[1:]))

    def test_receiver_route_has_unique_selected_udp_pair(self):
        selected={'local':{'address':'192.0.2.2','port':1234,'protocol':'udp'},
                  'remote':{'address':'192.0.2.1','port':5678,'protocol':'udp'}}
        row={'transport':{'transports':[{'selected':selected}]}}
        self.assertEqual(impaired.route(row),('192.0.2.1',5678,'192.0.2.2',1234))
        row['transport']['transports'].append({'selected':selected})
        self.assertIsNone(impaired.route(row))

    def test_old_session_and_duplicate_phase_are_rejected(self):
        row=dict(schema='impaired-run-events-v1',experiment='e',session='old',clock='elapsedRealtimeNanos',event='phase',phase='normal_start',observed_ns='10')
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'run.jsonl';p.write_text(json.dumps(row)+'\n')
            with self.assertRaises(ValueError):impaired.run_events(p,'e','new')
            row['session']='new';p.write_text((json.dumps(row)+'\n')*2)
            with self.assertRaises(ValueError):impaired.run_events(p,'e','new')

    def test_failed_attempts_and_unexecuted_categories_remain(self):
        samples=[dict(experiment='e',session='s',phase='formal',category='text_submit',start_ns='100',status='send_failed')]
        result=impaired.planned_attempts({'samples':samples},0,1000,'e','s')
        self.assertEqual([r['status'] for r in result],['send_failed','not_run','not_run','not_run'])
        samples[0]['session']='old'
        with self.assertRaises(ValueError):impaired.planned_attempts({'samples':samples},0,1000,'e','s')

    def test_interrupted_window_keeps_actual_duration(self):
        p={'impairment_start':100}
        result=impaired.window(p,'impairment_start','impairment_end',120,'s',[{'event':'session_ended','observed_ns':'500'}])
        self.assertFalse(result['completed']);self.assertEqual(result['end_ns'],'500')

if __name__=='__main__':unittest.main()
