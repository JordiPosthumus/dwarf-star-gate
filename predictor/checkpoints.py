"""Causal checkpoint selection for offline diagnostics, never request routing."""
import collections
import math


def first_progress(rows):
    """One actual observation before 30 seconds per job; never interpolate.

    decision_time is admission time shared by every row for a job. at is the
    observation clock. Missing/contradictory checkpoints are not tie-broken by
    input order, outcome or prediction error. Inputs are not modified.
    """
    if not isinstance(rows,list) or len(rows)>100000:raise ValueError('Checkpoint point bound')
    number=lambda v:type(v) in (int,float) and math.isfinite(v) and v>=0
    jobs=collections.defaultdict(list)
    for row in rows:
        if row.get('kind')!='remaining' or not all(isinstance(row.get(k),str) and row[k] for k in ('run_id','request_id')):
            raise ValueError('Checkpoint identity or kind invalid')
        jobs[(row['run_id'],row['request_id'])].append(row)
    selected=[];excluded={reason:0 for reason in ('invalid_checkpoint','no_observed_early_checkpoint','conflicting_earliest_checkpoint')}
    for points in jobs.values():
        if any(not all(number(r.get(k)) for k in ('at','decision_time','finish_time'))
               or not r['decision_time']<=r['at']<=r['finish_time']
               or not number(r.get('features',{}).get('elapsed_s')) for r in points):
            excluded['invalid_checkpoint']+=1;continue
        early=[r for r in points if r['features']['elapsed_s']<30]
        if not early:
            excluded['no_observed_early_checkpoint']+=1;continue
        earliest=min(r['at'] for r in early)
        tied=[r for r in early if r['at']==earliest]
        if any(r!=tied[0] for r in tied[1:]):
            excluded['conflicting_earliest_checkpoint']+=1;continue
        selected.append(tied[0])
    return selected,{'source_points':len(rows),'source_requests':len(jobs),'selected_requests':len(selected),
                     'excluded_requests':excluded,'elapsed_window_s':{'lower_inclusive':0,'upper_exclusive':30},
                     'note':'First observed remaining forecast before 30 seconds, selected by at, not admission decision_time. One point per request; identical duplicates count once. Missing early history is not proof there was no early forecast. Request exclusions partition the supplied jobs; other audit scores and input rows are unchanged.'}
