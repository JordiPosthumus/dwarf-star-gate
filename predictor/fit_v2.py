"""Bounded XGB candidates; fixed ablations/rounds, no routing or promotion power."""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import numpy as np
import xgboost as xgb

SCHEMA = 'dsg-latency-v2'
PARAMS = {'objective': 'reg:squarederror', 'tree_method': 'hist', 'device': 'cpu',
          'nthread': 2, 'max_depth': 2, 'eta': .05, 'min_child_weight': 3,
          'lambda': 10, 'seed': 42, 'subsample': 1, 'colsample_bytree': 1}
ROUNDS = (16, 64, 128)


def unique(rows):
    return len({(r['run_id'], r['request_id']) for r in rows})


def weights(rows):
    counts = collections.Counter((r['run_id'], r['request_id']) for r in rows)
    return np.asarray([1 / counts[(r['run_id'], r['request_id'])] for r in rows])


def split(rows, start, end=float('inf'), disjoint=False):
    validation = [r for r in rows if start <= r['decision_time'] < end]
    groups = {r['group'] for r in validation}
    training = [r for r in rows if r['decision_time'] < start and r['finish_time'] < start and (not disjoint or r['group'] not in groups)]
    return training, validation


def folds(rows):
    times = sorted({r['decision_time'] for r in rows})
    result = []
    if len(times) < 30:
        return result
    for fraction in (.4, .6, .8):
        start = times[int(len(times)*fraction)]
        index = int(len(times)*(fraction+.2))
        end = times[index] if index < len(times) else float('inf')
        tr, va = split(rows, start, end)
        if unique(tr) >= 15 and unique(va) >= 5 and len({r['group'] for r in tr}) >= 2:
            result.append((tr, va))
    return result


def encoding(rows, names, categorical):
    cats = [k for k in names if k in categorical]
    vocab = {k: sorted({r['features'][k] for r in rows if isinstance(r['features'].get(k), str)}) for k in cats}
    return {'names': names, 'categorical': cats, 'vocabulary': vocab,
            'encoded_names': [f'f{i}' for i in range(sum(len(vocab[k])+1 if k in cats else 1 for k in names))]}


def vector(features, enc):
    result = []
    for name in enc['names']:
        value = features.get(name)
        if name in enc['categorical']:
            vocabulary = enc['vocabulary'][name]
            at = vocabulary.index(value) if value in vocabulary else len(vocabulary)
            result.extend(float(i == at) for i in range(len(vocabulary)+1))
        else:
            result.append(float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else float('nan'))
    return np.asarray(result, dtype=np.float32)


def matrix(rows, enc):
    return xgb.DMatrix(np.vstack([vector(r['features'], enc) for r in rows]), feature_names=enc['encoded_names'])


def reference(features):
    """Causal hardware/session prior, not fitted using validation labels."""
    generation=features.get('history_generation_estimate_s')
    ttft=features.get('prior_ttft_s')
    recent=features.get('recent_service_mean')
    worker=next((features.get(k) for k in ('worker_service_median','hardware_service_median','fleet_service_median') if features.get(k) is not None),None)
    value=(generation+(ttft or 0)) if generation is not None else recent if features.get('same_prior_server')==1 and recent is not None else worker
    # 1 is a neutral positive transform anchor only, never a reported cold-start
    # forecast. No-history baseline comparisons use training-only worker means.
    if not isinstance(value,(float,int)) or not math.isfinite(value):value=1.0
    if features.get('stage')=='remaining':value=max(1.0,value-(features.get('elapsed_s') or 0))
    return max(1.0,value)


def fit(rows, names, cats, rounds, transform):
    enc = encoding(rows, names, cats)
    values = np.asarray([r['target_s'] for r in rows])
    data = matrix(rows, enc)
    references=np.asarray([reference(r['features']) for r in rows])
    data.set_label(np.log1p(values)-np.log1p(references) if transform=='relative_log' else np.log1p(values) if transform == 'log' else values)
    data.set_weight(weights(rows))
    model = xgb.train(PARAMS, data, num_boost_round=rounds)
    # Log back-transformation alone predicts neither an arithmetic expectation
    # nor a calibrated conditional mean. Smearing is explicit and tested later.
    margin=model.predict(data)
    raw = np.expm1(margin+np.log1p(references)) if transform=='relative_log' else np.expm1(margin) if transform == 'log' else margin
    factor = float(np.average(values, weights=weights(rows)) / max(1e-6, np.average(np.maximum(raw, 0), weights=weights(rows)))) if transform != 'raw' else 1.0
    return model, enc, factor


def predict(model, enc, factor, rows, transform):
    raw = model.predict(matrix(rows, enc))
    y = np.maximum(0, (np.expm1(raw+np.log1p([reference(r['features']) for r in rows])) if transform=='relative_log' else np.expm1(raw) if transform == 'log' else raw) * factor)
    if not np.isfinite(y).all():
        raise ValueError('Non-finite model output')
    return y


def metrics(rows, predicted):
    y = np.asarray([r['target_s'] for r in rows]); p = np.asarray(predicted); w = weights(rows)
    err = np.abs(y-p)
    long = y >= 300
    return {'requests': unique(rows), 'sessions': len({r['group'] for r in rows}),
            'mae_s': float(np.average(err, weights=w)), 'rmse_s': float(np.sqrt(np.average((y-p)**2, weights=w))),
            'bias_s': float(np.average(p-y, weights=w)), 'mean_ratio': float(np.average(p, weights=w)/max(.001,np.average(y, weights=w))),
            'long_requests': unique([r for r, flag in zip(rows, long) if flag]),
            'long_mae_s': float(np.average(err[long], weights=w[long])) if long.any() else None}


def baseline(tr, va):
    # Fixed alternatives, with no holdout tuning. Compare to BOTH worker means
    # and causal recent-history estimates, not just a weak global constant.
    total = float(np.average([r['target_s'] for r in tr], weights=weights(tr)))
    by = {}
    for node in {r['node'] for r in tr}:
        rr = [r for r in tr if r['node'] == node]
        by[node] = float(np.average([r['target_s'] for r in rr], weights=weights(rr)))
    means = [by.get(r['node'], total) for r in va]
    history = [r['features'].get('recent_service_mean') if r['kind'] != 'remaining' else None for r in va]
    history = [v if isinstance(v, (int,float)) and v >= 0 else m for v,m in zip(history,means)]
    causal=[reference(r['features']) if any(r['features'].get(k) is not None for k in ('worker_service_median','hardware_service_median','fleet_service_median')) else m for r,m in zip(va,means)]
    return {'worker_mean': metrics(va, means), 'recent_history': metrics(va, history),'causal_hardware_history':metrics(va,causal)}, means, history


def portable(model, enc, factor, transform):
    raw = json.loads(model.save_raw(raw_format='json'))['learner']
    base = raw['learner_model_param']['base_score']
    base = float(str(base).strip('[]'))
    trees = []
    for tree in raw['gradient_booster']['model']['trees']:
        if any(tree['split_type']):
            raise ValueError('Only numerical one-hot trees supported')
        trees.append({k: tree[k] for k in ['left_children','right_children','split_indices','split_conditions','default_left']})
    return {'encoding':enc,'base_margin':base,'trees':trees,'transform':transform,'factor':factor}


def exported_prediction(model, features):
    x = vector(features, model['encoding']); margin = np.float32(model['base_margin'])
    for t in model['trees']:
        i = 0
        while t['left_children'][i] != -1:
            v = x[t['split_indices'][i]]
            left = bool(t['default_left'][i]) if np.isnan(v) else v < t['split_conditions'][i]
            i = t['left_children'][i] if left else t['right_children'][i]
        margin = np.float32(margin + np.float32(t['split_conditions'][i]))
    raw = math.expm1(float(margin)+math.log1p(reference(features))) if model['transform']=='relative_log' else math.expm1(float(margin)) if model['transform']=='log' else float(margin)
    return max(0, raw*model['factor'])


def train(prepared):
    if xgb.__version__!='3.4.1' or np.__version__!='2.5.2':
        raise ValueError('Use the locked predictor environment; dependency version mismatch')
    data=json.loads(Path(prepared).read_text()); rows=data['rows']
    if data['schema'] != SCHEMA or len(rows)>100000:
        raise ValueError('Unsupported prepared data')
    result={'schema':2,'feature_schema':SCHEMA,'created_at':dt.datetime.now(dt.timezone.utc).isoformat(),
            'snapshot':data['snapshot'],'dependencies':{'xgboost':xgb.__version__,'numpy':np.__version__},'models':{},'reports':{},'routing_enabled':False}
    for kind in ('admission','updated','remaining'):
        subset=[r for r in rows if r['kind']==kind and math.isfinite(r['target_s']) and r['target_s']>=0]
        count=unique(subset); report={'requests':count,'sessions':len({r['group'] for r in subset}),'status':'insufficient_evidence'}
        result['reports'][kind]=report
        times=sorted({r['decision_time'] for r in subset})
        if count<50 or len(times)<20:continue
        cutoff=times[int(len(times)*.8)]; tr,te=split(subset,cutoff); cv=folds(tr)
        report.update(training_requests=unique(tr),holdout_requests=unique(te),folds=len(cv))
        if unique(tr)<25 or unique(te)<10 or len(cv)<2:continue
        candidates=[]
        families=[['base'],['base','history'],['base','history','ratios'],['base','history','ratios','semantic']]
        for family in families:
            if kind=='remaining':family=family+['progress']
            names=[k for g in family for k in data['groups'][g]]
            for transform in ('raw','log','relative_log'):
                for rounds in ROUNDS:
                    scores=[]
                    for training, validation in cv:
                        model,enc,factor=fit(training,names,data['categorical'],rounds,transform)
                        scores.append(metrics(validation,predict(model,enc,factor,validation,transform)))
                    score=sum(m['mae_s']*m['requests'] for m in scores)/sum(m['requests'] for m in scores)
                    candidates.append({'family':family,'rounds':rounds,'transform':transform,'mae_s':score,'fold_metrics':scores,'names':names})
        winner=min(candidates,key=lambda c:(c['mae_s'],len(c['names']),c['rounds']))
        model,enc,factor=fit(tr,winner['names'],data['categorical'],winner['rounds'],winner['transform'])
        predictions=predict(model,enc,factor,te,winner['transform']); measured=metrics(te,predictions)
        baselines,_,_=baseline(tr,te)
        by_worker={node:metrics([r for r in te if r['node']==node],[float(p) for r,p in zip(te,predictions) if r['node']==node]) for node in {r['node'] for r in te}}
        # Gate is deliberately immutable code, not a parameter the Genie supplies.
        best_baseline=min(x['mae_s'] for x in baselines.values())
        passed=unique(te)>=20 and measured['sessions']>=3 and measured['mae_s']<=best_baseline*.9 and .7<=measured['mean_ratio']<=1.3
        unseen=[r for r in te if r['group'] not in {x['group'] for x in tr}]
        unseen_metrics=metrics(unseen,predict(model,enc,factor,unseen,winner['transform'])) if unseen else None
        unseen_baselines=baseline(tr,unseen)[0] if unseen else None
        unseen_passed=bool(unseen_metrics and unseen_metrics['requests']>=20 and unseen_metrics['sessions']>=3 and unseen_metrics['mae_s']<=min(m['mae_s'] for m in unseen_baselines.values())*.9 and .7<=unseen_metrics['mean_ratio']<=1.3)
        report.update(status='holdout_passed' if passed else 'holdout_failed',selected={k:v for k,v in winner.items() if k!='names'},ablations=[{k:v for k,v in c.items() if k not in ('names','fold_metrics')} for c in candidates],holdout=measured,baselines=baselines,by_worker=by_worker,cutoff=cutoff,unseen_session=unseen_metrics,unseen_session_passed=unseen_passed,
                      training_groups=sorted({r['group'] for r in tr}),holdout_groups=sorted({r['group'] for r in te}),holdout_passed=passed,
                      feature_availability='shared chronological replay; strictly earlier completed history',tree_selection='forward-time folds inside training; unfinished labels purged; recurring sessions allowed; separate unseen-session placement gate')
        # Export the EXACT evaluated model. No unevaluated all-data refit is
        # silently substituted for the artifact that earned these measurements.
        export=portable(model,enc,factor,winner['transform'])
        actual=np.asarray([exported_prediction(export,r['features']) for r in te]);np.testing.assert_allclose(actual,predictions,rtol=2e-5,atol=1e-3)
        model_id=hashlib.sha256(json.dumps(export,sort_keys=True).encode()).hexdigest()
        export.update(id=model_id,kind=kind,holdout_passed=passed,holdout=measured,baseline_mae_s=best_baseline,new_session_validated=unseen_passed,
                      support={node:{'profiles':sorted({r['profile'] for r in tr if r['node']==node}),'requests':unique([r for r in tr if r['node']==node]),'first_observed_requests':unique([r for r in tr if r['node']==node and r['features'].get('history_count')==0]),'max_elapsed_s':max([r['features'].get('elapsed_s') or 0 for r in tr if r['node']==node])} for node in {r['node'] for r in tr}},
                      parity=[{'features':r['features'],'seconds':float(p)} for r,p in list(zip(te,predictions))[:8]])
        result['models'][kind]=export
    return result


def main():
    os.umask(0o077);parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--prepared',required=True);args=parser.parse_args()
    directory=Path(args.prepared).parent;target=directory/'candidate.json'
    if target.exists():raise ValueError('Candidate already exists')
    candidate=train(args.prepared)
    candidate['trainer_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with target.open('x') as f:json.dump(candidate,f,allow_nan=False,separators=(',',':'));f.write('\n')
    report={'schema':2,'created_at':candidate['created_at'],'reports':candidate['reports'],'candidate_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'models':{k:v['id'] for k,v in candidate['models'].items()}}
    with (directory/'report.json').open('x') as f:json.dump(report,f,allow_nan=False,indent=2);f.write('\n')
    print(json.dumps({'models':list(candidate['models']),'reports':{k:{kk:vv for kk,vv in v.items() if kk in ('status','requests','holdout','baselines','selected')} for k,v in candidate['reports'].items()}}))


if __name__=='__main__':
    main()
