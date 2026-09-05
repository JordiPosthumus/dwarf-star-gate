import copy
import itertools
import json
import unittest

from checkpoints import first_progress
from occupancy_future import first_progress_comparison


def row(name='private-job',at=1100,age=1,**extra):
    return {'kind':'remaining','stage':'remaining','run_id':'private-run','request_id':name,
            'node':'example-worker','group':'example-session','decision_time':1000,
            'finish_time':100000,'at':at,'target_s':20,'features':{'elapsed_s':age},**extra}


class CheckpointTests(unittest.TestCase):
    def test_observation_clock_not_shared_admission_or_outcome_selects_first(self):
        early=row(at=1100,age=1,target_s=999);later=row(at=1200,age=2,target_s=1)
        original=copy.deepcopy([early,later])
        for order in ([early,later],[later,early]):
            selected,counts=first_progress(order)
            self.assertEqual(selected,[early]);self.assertIs(selected[0],early)
            self.assertEqual(counts['selected_requests'],1)
        self.assertEqual([early,later],original)

    def test_identical_duplicates_count_once_conflicts_abstain_in_every_order(self):
        a=row();duplicate=copy.deepcopy(a);conflict=row(target_s=21)
        selected,counts=first_progress([a,duplicate])
        self.assertEqual(selected,[a]);self.assertEqual(counts['source_points'],2)
        for order in itertools.permutations([a,duplicate,conflict]):
            selected,counts=first_progress(list(order))
            self.assertEqual(selected,[])
            self.assertEqual(counts['excluded_requests']['conflicting_earliest_checkpoint'],1)

    def test_window_boundaries_missing_evidence_and_run_identity(self):
        points=[row(age=0),row(at=100000,age=29.999,run_id='another-run'),row('late',age=30)]
        selected,counts=first_progress(points)
        self.assertEqual(selected,points[:2]);self.assertEqual(counts['source_requests'],3)
        self.assertEqual(counts['excluded_requests']['no_observed_early_checkpoint'],1)
        self.assertNotIn('private-',json.dumps(counts));self.assertNotIn('example-worker',json.dumps(counts))
        selected,counts=first_progress([])
        self.assertEqual(selected,[]);self.assertEqual(counts['source_requests'],0)

    def test_invalid_clock_or_age_does_not_fall_through_to_later_checkpoint(self):
        for key,value in [('at',None),('at',True),('at',float('nan')),('at',999),('at',100001),
                          ('decision_time',None),('finish_time',False)]:
            selected,counts=first_progress([row(**{key:value}),row(at=1200,age=2)])
            self.assertEqual(selected,[]);self.assertEqual(counts['excluded_requests']['invalid_checkpoint'],1)
        for age in (None,True,-1,float('inf')):
            self.assertEqual(first_progress([row(age=age)])[1]['excluded_requests']['invalid_checkpoint'],1)

    def test_bounded_kind_and_identity_contract(self):
        for points in (None,[row()]*100001,[row(kind='admission')],[row(run_id='')]):
            with self.assertRaises(ValueError):first_progress(points)

    def test_comparison_is_one_vote_per_job_with_exact_prediction_alignment(self):
        a=row(at=1100,age=1);b=row(at=1200,age=2)
        c=row('second',at=1150,age=1,target_s=120)
        # A late poor forecast must not contaminate the first-progress result.
        report=first_progress_comparison([row('train')],[b,c,a],[1000,20,20])
        self.assertEqual(report['metrics']['requests'],2)
        self.assertEqual(report['metrics']['mae_s'],50)
        self.assertEqual(report['baselines']['worker_mean']['mae_s'],50)
        self.assertIsNone(first_progress_comparison([],[],[])['metrics'])
        self.assertIsNone(first_progress_comparison([],[],[])['baselines'])
        with self.assertRaises(ValueError):first_progress_comparison([a],[a],[])


if __name__=='__main__':unittest.main()
