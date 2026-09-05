"""Frozen offline residual-life experiment. Never loaded by the gateway."""
import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path

from occupancy_future import contracts, read_json, timestamp
from fit_v2 import baseline, exported_prediction, metrics, split, weights

POLICY='same_worker_empirical_residual_v1'


def number(value):
    return type(value) in (int,float) and math.isfinite(value) and value>=0


def fit_history(rows, cutoff):
    """One observed terminal occupancy per job; purge labels unavailable at cutoff."""
    if not number(cutoff) or len(rows)>100000:raise ValueError('Invalid training bounds')
    jobs={}
    for row in rows:
        if row.get('kind')!='admission':continue
        if not all(number(row.get(k)) for k in ('decision_time','finish_time','target_s')) or row['finish_time']<row['decision_time']:
            raise ValueError('Invalid admission label')
        if row.get('target_contract')!='observed_terminal_occupancy' or row.get('terminal_class') not in ('normal','output_limited'):
            raise ValueError('Unsupported occupancy label')
        if not all(isinstance(row.get(k),str) and row[k] for k in ('run_id','request_id','node')):raise ValueError('Missing job identity')
        key=(row['run_id'],row['request_id'])
        if key in jobs and jobs[key]!=row:raise ValueError('Contradictory admission')
        jobs[key]=row
    pools=collections.defaultdict(list)
    for row in jobs.values():
        if row['decision_time']<cutoff and row['finish_time']<cutoff:pools[row['node']].append(row['target_s'])
    return {node:sorted(values) for node,values in sorted(pools.items())}


class ResidualLife:
    def __init__(self,pools):
        self.pools={};self.sums={}
        for node,values in pools.items():
            if not isinstance(values,list) or not all(number(v) for v in values) or values!=sorted(values):raise ValueError('Invalid duration pool')
            self.pools[node]=values
            suffix=[0.]*(len(values)+1)
            for i in range(len(values)-1,-1,-1):suffix[i]=suffix[i+1]+values[i]
            if not math.isfinite(suffix[0]):raise ValueError('Duration sum overflow')
            self.sums[node]=suffix

    def predict(self,node,elapsed):
        if not number(elapsed):return {'status':'unknown_age','support':0}
        if node not in self.pools:return {'status':'unknown_worker','support':0}
        values=self.pools[node];start=bisect.bisect_right(values,elapsed);count=len(values)-start
        if not count:return {'status':'no_survivors','support':0}
        # Strict T > elapsed; a finished historical job does not survive this age.
        quantile=lambda q:values[start+max(0,math.ceil(q*count)-1)]-elapsed
        return {'status':'observed','support':count,'mean_s':max(0.,self.sums[node][start]/count-elapsed),
                'p10_s':quantile(.1),'median_s':quantile(.5),'p90_s':quantile(.9)}


def source_hash():
    root=Path(__file__).parent
    return hashlib.sha256(b''.join(name.encode()+b'\0'+(root/name).read_bytes() for name in ('residual_life.py','occupancy_future.py','fit_v2.py'))).hexdigest()


def freeze(candidate_path,training_path,output):
    candidate,ch=read_json(candidate_path);training,th=read_json(training_path);contracts(candidate,training)
    if 'remaining' not in candidate['models']:raise ValueError('Remaining comparator required')
    cutoff=candidate['reports']['remaining']['cutoff'];pools=fit_history(training['rows'],cutoff)
    if not pools:raise ValueError('No completed training admissions')
    ResidualLife(pools)  # Validate sums before publishing a frozen artifact.
    now=dt.datetime.now(dt.timezone.utc).isoformat()
    if max(timestamp(candidate['created_at']),timestamp(training['snapshot']['created_at']),cutoff)>timestamp(now):raise ValueError('Future training timestamp')
    artifact={'schema':1,'policy':POLICY,'routing_enabled':False,'frozen_at':now,'source_sha256':source_hash(),
              'candidate_sha256':ch,'training_sha256':th,'training_cutoff_ms':cutoff,'pools':pools}
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(artifact,stream,sort_keys=True,allow_nan=False);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    return {'policy':POLICY,'routing_enabled':False,'frozen_at':now,'training_jobs':sum(map(len,pools.values())),
            'source_sha256':artifact['source_sha256'],'candidate_sha256':ch,'training_sha256':th}


def compare(rows,training_rows,model,estimator):
    pairs=[];reasons=collections.Counter();all_jobs=set();covered_jobs=set()
    for row in rows:
        key=(row['run_id'],row['request_id']);all_jobs.add(key)
        prediction=estimator.predict(row['node'],row['features'].get('elapsed_s'))
        reasons[prediction['status']]+=1
        if prediction['status']=='observed':pairs.append((row,prediction));covered_jobs.add(key)
    result={'points':len(rows),'requests':len(all_jobs),'covered_points':len(pairs),'requests_with_covered_points':len(covered_jobs),
            'point_status':dict(reasons),'matched_metrics':None,'empirical_interval':None,'support_range':None}
    if not pairs:return result
    matched=[row for row,_ in pairs];predictions=[p for _,p in pairs]
    result['matched_metrics']={'conditional_mean':metrics(matched,[p['mean_s'] for p in predictions]),
        'conditional_median':metrics(matched,[p['median_s'] for p in predictions]),
        'frozen_xgb':metrics(matched,[exported_prediction(model,r['features']) for r in matched]),**baseline(training_rows,matched)[0]}
    ww=weights(matched);total=float(sum(ww))
    result['empirical_interval']={'nominal_mass':.8,'calibrated':False,
        'observed_coverage':sum(float(w)*(p['p10_s']<=r['target_s']<=p['p90_s']) for (r,p),w in zip(pairs,ww))/total,
        'mean_width_s':sum(float(w)*(p['p90_s']-p['p10_s']) for (_,p),w in zip(pairs,ww))/total}
    result['support_range']={'min':min(p['support'] for p in predictions),'max':max(p['support'] for p in predictions)}
    return result


def evaluate(candidate_path,training_path,artifact_path,prepared_path=None):
    candidate,ch=read_json(candidate_path);training,th=read_json(training_path);contracts(candidate,training)
    artifact,ah=read_json(artifact_path);cut=candidate['reports']['remaining']['cutoff']
    if artifact.get('schema')!=1 or artifact.get('policy')!=POLICY or artifact.get('routing_enabled') is not False or artifact.get('source_sha256')!=source_hash():raise ValueError('Residual policy changed')
    if artifact.get('candidate_sha256')!=ch or artifact.get('training_sha256')!=th or artifact.get('training_cutoff_ms')!=cut or artifact.get('pools')!=fit_history(training['rows'],cut):raise ValueError('Frozen training identity changed')
    frozen=timestamp(artifact['frozen_at'])
    if frozen<max(timestamp(candidate['created_at']),timestamp(training['snapshot']['created_at']),cut):raise ValueError('Invalid freeze time')
    tr,holdout=split([r for r in training['rows'] if r['kind']=='remaining'],cut)
    if not tr:raise ValueError('Empty remaining comparison training')
    if prepared_path:
        data,ph=read_json(prepared_path);end=timestamp(data['snapshot']['created_at'])
        if end<frozen:raise ValueError('Snapshot precedes experiment freeze')
        if data.get('schema')!=training['schema'] or data.get('feature_schema')!=training['feature_schema'] or data['snapshot']['feature_builder_sha256']!=training['snapshot']['feature_builder_sha256'] or data['snapshot']['hashes']['worker-inventory.json']!=training['snapshot']['hashes']['worker-inventory.json']:raise ValueError('Future feature/profile contract changed')
        if not isinstance(data.get('rows'),list) or len(data['rows'])>100000:raise ValueError('Evaluation point bound')
        seen={(r['run_id'],r['request_id']) for r in training['rows']};first={}
        for row in data['rows']:
            if not all(number(row.get(k)) for k in ('decision_time','finish_time')):raise ValueError('Invalid evidence clock')
            key=(row['run_id'],row['request_id']);first[key]=min(first.get(key,float('inf')),row['decision_time'])
        rows=[r for r in data['rows'] if r['kind']=='remaining' and frozen<r['decision_time']<=r['finish_time']<=end and
              first[(r['run_id'],r['request_id'])]>frozen and (r['run_id'],r['request_id']) not in seen]
        mode='frozen_future'
    else:rows=holdout;ph=None;mode='exploratory_existing_holdout'
    if len(rows)>100000:raise ValueError('Evaluation point bound')
    for r in rows:
        if r.get('target_contract')!='observed_terminal_occupancy' or r.get('terminal_class') not in ('normal','output_limited') or not number(r.get('target_s')):raise ValueError('Invalid occupancy target')
    estimator=ResidualLife(artifact['pools']);model=candidate['models']['remaining']
    report={'schema':1,'policy':POLICY,'mode':mode,'authority':'none','routing_enabled':False,'artifact_sha256':ah,'prepared_sha256':ph,
            'frozen_at':artifact['frozen_at'],'all':compare(rows,tr,model,estimator),'by_elapsed':{}}
    for name,low,high in [('under_30s',0,30),('30s_to_5m',30,300),('5m_plus',300,float('inf'))]:
        points=[r for r in rows if number(r['features'].get('elapsed_s')) and low<=r['features']['elapsed_s']<high]
        report['by_elapsed'][name]=compare(points,tr,model,estimator)
    report['limitations']=['Completed-only empirical history is not a censoring-aware survival model.',
        'Same-worker history does not certify an unchanged engine/profile era; no cross-worker fallback.',
        'Historical quantiles are not calibrated confidence intervals; sparse support can make them degenerate.',
        'Matched scores exclude abstained points; request coverage can be partial. Age slices can share jobs.',
        'Existing holdout has already informed development and is exploratory, not an independent release gate.',
        'No live routing, artifact promotion, output limit or request replay authority.']
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('freeze','evaluate'))
    for key in ('candidate','training','artifact'):parser.add_argument('--'+key,required=True)
    parser.add_argument('--prepared');args=parser.parse_args()
    try:
        result=freeze(args.candidate,args.training,args.artifact) if args.mode=='freeze' else evaluate(args.candidate,args.training,args.artifact,args.prepared)
        print(json.dumps(result,allow_nan=False))
    except (ValueError,KeyError,TypeError,OSError) as error:parser.exit(1,'Residual-life experiment rejected: '+type(error).__name__+'\n')
