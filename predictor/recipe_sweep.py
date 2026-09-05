"""Offline occupancy recipe sweep; choose by training CV, never holdout accuracy."""
import argparse
import copy
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path

from fit_v2 import RECIPE_HASH, RECIPE_POLICY, model_identity, train

RECIPES=('standard-v1','regularized-v1','interactions-v1')
KINDS=('admission','updated','remaining')


def select_trials(trials,created_at):
    if len(trials)!=len(RECIPES):raise ValueError('All reviewed recipes required')
    base=trials[0]
    for trial,recipe in zip(trials,RECIPES,strict=True):
        if trial.get('schema')!=2 or trial.get('routing_enabled') is not False or trial.get('feature_schema') not in ('dsg-occupancy-v1','dsg-occupancy-v2'):
            raise ValueError('Only offline occupancy trials are supported')
        if any(trial.get(key)!=base.get(key) for key in ('snapshot','feature_schema','dependencies')):
            raise ValueError('Trials must share snapshot, schema and dependencies')
        if trial.get('training_recipe',{}).get('id')!=recipe or trial['training_recipe'].get('policy_sha256')!=RECIPE_HASH:
            raise ValueError('Unreviewed recipe or policy changed')
    result=copy.deepcopy(base);result.update(created_at=created_at,models={},reports={})
    selections={};hashes={recipe:hashlib.sha256(json.dumps(trial,sort_keys=True,allow_nan=False).encode()).hexdigest() for recipe,trial in zip(RECIPES,trials)}
    for kind in KINDS:
        comparable=[];summaries=[];partition=None
        for index,(recipe,trial) in enumerate(zip(RECIPES,trials)):
            report=trial['reports'][kind]
            current={key:report.get(key) for key in ('cutoff','training_requests','holdout_requests','folds','target_coverage')}
            if partition is None:partition=current
            elif current!=partition:raise ValueError('Recipe validation partitions differ')
            score=report.get('selected',{}).get('mae_s')
            summaries.append({'recipe':recipe,'training_cv_mae_s':score,'status':report['status']})
            if kind in trial['models']:
                if type(score) not in (int,float) or not math.isfinite(score) or score<0:raise ValueError('Invalid training CV score')
                comparable.append((score,index))
        if not comparable:
            result['reports'][kind]={**copy.deepcopy(base['reports'][kind]),'recipe_trials':summaries};continue
        # Stable reviewed order breaks ties. No holdout/baseline/gate field enters
        # this comparison, even when the CV winner fails its later release gate.
        _,index=min(comparable);chosen=trials[index];recipe=RECIPES[index]
        model=copy.deepcopy(chosen['models'][kind]);report=copy.deepcopy(chosen['reports'][kind])
        forest={key:model[key] for key in ('encoding','base_margin','trees','transform','factor')}
        model['id']=model_identity(forest,kind,result['snapshot'],created_at)
        model['training_recipe_id']=recipe
        report.update(selected_recipe=recipe,recipe_trials=summaries,
                      recipe_selection='training-only forward-time CV; stable reviewed-order ties; holdout gates unchanged')
        result['models'][kind]=model;result['reports'][kind]=report;selections[kind]=copy.deepcopy(chosen['training_recipe'])
    result['training_recipe']={'id':'reviewed-cv-sweep-v1','policy_sha256':RECIPE_HASH,'recipes':list(RECIPES),
                               'selected_by_kind':selections,'trial_sha256':hashes,
                               'selection':'training CV only, no holdout selection or all-data refit'}
    return result


def sweep(prepared,output):
    if tuple(recipe['id'] for recipe in RECIPE_POLICY['recipes'])!=RECIPES:raise ValueError('Reviewed sweep budget changed')
    directory=Path(output)
    # Require a fresh destination before any expensive work. No previous candidate
    # is overwritten; failures leave their explicitly incomplete private directory.
    directory.mkdir(mode=0o700,parents=False,exist_ok=False)
    trials=[]
    for recipe in RECIPES:
        candidate=train(prepared,recipe,occupancy=True)
        write_private(directory/(recipe+'.json'),candidate)
        trials.append(candidate)
    result=select_trials(trials,dt.datetime.now(dt.timezone.utc).isoformat())
    result['trainer_sha256']=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('fit_v2.py').read_bytes()).hexdigest()
    write_private(directory/'occupancy-candidate.json',result)
    summary={'schema':1,'routing_enabled':False,'selected':{kind:{'recipe':r.get('selected_recipe'),'cv':r.get('selected',{}).get('mae_s'),
                'status':r['status'],'holdout':r.get('holdout'),'baselines':r.get('baselines')} for kind,r in result['reports'].items()}}
    write_private(directory/'report.json',summary)
    return summary


def write_private(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(data,stream,allow_nan=False,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())


if __name__=='__main__':
    os.umask(0o077);parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    try:print(json.dumps(sweep(args.prepared,args.output),allow_nan=False))
    except (ValueError,KeyError,TypeError,OSError) as error:parser.exit(1,'Recipe sweep rejected: '+type(error).__name__+'\n')
