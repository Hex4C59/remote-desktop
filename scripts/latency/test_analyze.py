"""Synthetic arithmetic/provenance checks, never physical measurement evidence."""

import copy
import unittest

from analyze import analyze


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.index = {'video_sha256': 'test-video', 'frames': [
            {'pts_seconds': x} for x in ['1.000', '1.033', '1.100', '1.134']]}
        self.row = dict(event_id='E-display-R1-S01', metric='display', status='valid',
                        phase='formal', annotation_method='manual',
                        experiment='E', session_uuid='S', round=1, source_head='H',
                        builds={'apk': 'A', 'sender': 'B'},
                        statistics_correlation={'seq_before': 2, 'seq_after': 3},
                        start=dict(last_absent=0, first_present=1, reviewer='tester',
                                   raw_frames_reviewed=True, rule='unique ID legible'),
                        end=dict(last_absent=2, first_present=3, reviewer='tester',
                                 raw_frames_reviewed=True, rule='same ID legible'))

    def run_rows(self, *rows):
        return analyze(self.index, {'video_sha256': 'test-video', 'samples': list(rows),
                                   'recording': {'original_speed_verified': True,
                                                 'duplicate_and_gap_review': 'synthetic fixture'}})

    def test_vfr_uses_pts_not_frame_count_or_nominal_fps(self):
        result = self.run_rows(self.row)
        self.assertEqual(result['samples'][0]['pts_bracket_ms'], ['67.000', '134.000'])
        self.assertIsNone(result['samples'][0]['expanded_interval_ms'])

    def test_optical_margin_expands_both_sides(self):
        self.row.update(additional_optical_uncertainty_ms='20', uncertainty_basis='synthetic')
        result = self.run_rows(self.row)['samples'][0]
        self.assertEqual(result['expanded_interval_ms'], ['47.000', '154.000'])

    def test_missing_raw_review_is_rejected(self):
        self.row['start']['raw_frames_reviewed'] = False
        with self.assertRaises(ValueError):
            self.run_rows(self.row)

    def test_invalid_bracket_and_nonfinite_margin_rejected(self):
        self.row['start']['last_absent'] = -1
        with self.assertRaises(ValueError):
            self.run_rows(self.row)
        self.row['start']['last_absent'] = 0
        self.row.update(additional_optical_uncertainty_ms='NaN', uncertainty_basis='synthetic')
        with self.assertRaises(ValueError):
            self.run_rows(self.row)

    def test_failures_retained_and_not_in_success_median(self):
        failed = dict(event_id='E-display-R1-S02', metric='display', status='timeout',
                      phase='formal',
                      reason='No matching optical result within 5 seconds')
        result = self.run_rows(self.row, failed)
        self.assertEqual(len(result['samples']), 2)
        self.assertEqual(result['summary']['display']['statuses'], {'valid': 1, 'timeout': 1})

    def test_duplicate_id_or_wrong_video_rejected(self):
        with self.assertRaises(ValueError):
            self.run_rows(self.row, self.row)
        with self.assertRaises(ValueError):
            analyze(self.index, {'video_sha256': 'other', 'samples': [self.row]})

    def test_summary_does_not_drop_unknown_uncertainty(self):
        other = copy.deepcopy(self.row)
        other['event_id'] = 'E-display-R1-S02'
        other.update(additional_optical_uncertainty_ms=10, uncertainty_basis='synthetic')
        result = self.run_rows(self.row, other)['summary']['display']
        self.assertIsNone(result['expanded_interval_ms'])
        self.assertIsNone(result['percentiles'])

    def test_warmups_are_retained_but_not_in_formal_summary(self):
        self.row['phase'] = 'warmup'
        result = self.run_rows(self.row)
        self.assertEqual(len(result['samples']), 1)
        self.assertEqual(result['summary']['display']['valid_n'], 0)
        self.assertEqual(result['summary']['display']['warmup_statuses'], {'valid': 1})


if __name__ == '__main__':
    unittest.main()
