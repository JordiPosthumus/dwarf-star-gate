"""Frozen-model future audit. Offline only; never promotes or changes routing."""
import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
import os
import stat

from fit_v2 import OCCUPANCY_SCHEMAS, SCHEMAS, baseline, exported_prediction, feature_coverage, known_session, metrics, session_evidence, split, split_usage, target_coverage


def read_json(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>128*1024**2:
            raise ValueError('Audit input must be a bounded regular file')
        with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(128*1024**2+1)
        if len(raw)>128*1024**2:raise ValueError('Audit input exceeded size bound')
        return json.loads(raw),hashlib.sha256(raw).hexdigest()
    finally:os.close(fd)


def timestamp(value):
    parsed=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('Audit timestamps require a timezone')
    return parsed.timestamp()*1000


def contracts(candidate,training,*,completion=False):
    schemas=SCHEMAS if completion else OCCUPANCY_SCHEMAS
    if candidate.get('schema')!=2 or candidate.get('feature_schema') not in schemas or candidate.get('routing_enabled') is not False:
        raise ValueError('Candidate does not match the explicit audit target mode')
    expected_features=None if completion else OCCUPANCY_SCHEMAS[candidate['feature_schema']]
    if training.get('schema')!=candidate['feature_schema'] or training.get('feature_schema')!=expected_features or candidate.get('snapshot')!=training.get('snapshot'):
        raise ValueError('Training snapshot does not match the frozen candidate')
    if not candidate.get('models') or any(k not in ('admission','updated','remaining') for k in candidate['models']):
        raise ValueError('Unsupported forecast model kinds')


def input_support(model, training_rows, future_rows, hardware_names, groups=None):
    """Collection, selection and actual tree use are different facts, not importance.

    Use the versioned hardware group, not a name prefix: hardware_family and
    hardware_service_median are static/history inputs, not live telemetry.
    Fractions describe forecast points, not independent request counts.
    """
    selected=set(model['encoding']['names']);used=split_usage(model)
    def describe(names):
        names=sorted(set(names))
        return {'collected_features':len(names),
                'selected':[name for name in names if name in selected],
                'used_in_splits':{name:used[name] for name in names if name in used},
                'training_point_coverage':feature_coverage(training_rows,names) if training_rows else None,
                'future_point_coverage':feature_coverage(future_rows,names) if future_rows else None}
    groups=groups or {}
    by_stage={}
    for stage in ('admission','upload','embedded','remaining'):
        points=[r for r in future_rows if r.get('stage',r.get('kind'))==stage]
        by_stage[stage]={'points':len(points),'point_coverage':{
            group:feature_coverage(points,sorted(set(names))) if points else None
            for group,names in sorted(groups.items())}}
    return {'selected_features':len(selected),'split_features':len(used),
            'hardware':describe(hardware_names),
            'feature_groups':{group:describe(names) for group,names in sorted(groups.items())},
            'future_by_stage':by_stage,
            'note':'Split counts are structural use, not importance or causal benefit. Coverage is per forecast point; no future-data fitting.'}


def updated_stage_pairs(rows, predictions, *, completion=False):
    """Compare like-for-like checkpoints, not different marginal populations.

    Exactly one upload and embedded point with the same terminal target are
    required. Ambiguous evidence stays in the other audit counts, not this
    paired comparison. This is a forecast diagnostic, not feature attribution.
    """
    jobs=collections.defaultdict(lambda: collections.defaultdict(list))
    for row,prediction in zip(rows,predictions,strict=True):
        if row.get('kind')!='updated' or row.get('stage') not in ('upload','embedded'):
            raise ValueError('Unsupported updated checkpoint')
        if type(prediction) not in (int,float) or not math.isfinite(prediction):
            raise ValueError('Invalid paired prediction')
        jobs[(row['run_id'],row['request_id'])][row['stage']].append((row,prediction))
    excluded={reason:0 for reason in ('missing_upload','missing_embedded','ambiguous_checkpoint','different_target')}
    pairs=[]
    for stages in jobs.values():
        if any(len(points)!=1 for points in stages.values()):
            excluded['ambiguous_checkpoint']+=1;continue
        missing=next((stage for stage in ('upload','embedded') if not stages.get(stage)),None)
        if missing:
            excluded['missing_'+missing]+=1;continue
        upload,embedded=stages['upload'][0],stages['embedded'][0]
        keys=('node','decision_time','finish_time','target_s')+(() if completion else ('target_contract','terminal_class'))
        if any(key not in upload[0] or key not in embedded[0] or upload[0][key]!=embedded[0][key] for key in keys):
            excluded['different_target']+=1;continue
        pairs.append((upload,embedded))
    upload_errors=[abs(u[1]-u[0]['target_s']) for u,e in pairs]
    embedded_errors=[abs(e[1]-e[0]['target_s']) for u,e in pairs]
    deltas=[e-u for u,e in zip(upload_errors,embedded_errors,strict=True)]
    mean=lambda values:math.fsum(values)/len(values) if values else None
    return {'requests':len(jobs),'paired_requests':len(pairs),'excluded_requests':excluded,
            'prediction_changed_requests':sum(u[1]!=e[1] for u,e in pairs),
            'upload_mae_s':mean(upload_errors),'embedded_mae_s':mean(embedded_errors),
            'mean_absolute_error_change_s':mean(deltas),
            'improved_requests':sum(d<0 for d in deltas),'worsened_requests':sum(d>0 for d in deltas),
            'unchanged_error_requests':sum(d==0 for d in deltas),
            'note':'One vote per matched request; negative error change is better after embeddings. Predictions may differ because of any changed input, not necessarily semantic features. No confidence, promotion or routing authority; excluded points remain in marginal reports.'}


def elapsed_slices(training_rows, rows, predictions):
    """Fixed diagnostic horizons, not outcome-selected cohorts or tuning gates.

    Remaining target duration is not how long a request has already occupied a
    worker. Keep those axes separate; rebalance jobs within each age slice, and
    retain unavailable ages as unknown instead of making them fresh dispatches.
    """
    bands={name:[] for name in ('under_30s','30s_to_5m','5m_plus','unknown')}
    for row,prediction in zip(rows,predictions,strict=True):
        age=row['features'].get('elapsed_s')
        valid=type(age) in (int,float) and math.isfinite(age) and age>=0
        name='unknown' if not valid else 'under_30s' if age<30 else '30s_to_5m' if age<300 else '5m_plus'
        bands[name].append((row,prediction))
    result={}
    for name,pairs in bands.items():
        selected=[row for row,_ in pairs];estimates=[p for _,p in pairs]
        result[name]={'points':len(selected),
                      'metrics':metrics(selected,estimates) if selected else None,
                      'baselines':baseline(training_rows,selected)[0] if selected else None}
    return result


def future_strata(training_rows, rows, predictions):
    """Describe transfer evidence, not a new release gate or model selector.

    Familiarity uses only the fitted partition, not every session in the frozen
    input snapshot. Missing session identity is neither familiar nor unseen.
    Reweight each slice by request so verbose progress cannot dominate it.
    """
    known={r['group'] for r in training_rows if known_session(r.get('group'))}
    workers=collections.defaultdict(list)
    sessions={name:[] for name in ('seen_in_training','unseen_in_training','unknown')}
    for row,prediction in zip(rows,predictions,strict=True):
        workers[row['node']].append((row,prediction))
        group=row.get('group')
        bucket='unknown' if not known_session(group) else 'seen_in_training' if group in known else 'unseen_in_training'
        sessions[bucket].append((row,prediction))
    def summarize(pairs):
        points=[row for row,_ in pairs];estimates=[p for _,p in pairs]
        return {'points':len(points),'metrics':metrics(points,estimates) if points else None,
                'baselines':baseline(training_rows,points)[0] if points else None}
    return {'by_worker':{node:summarize(pairs) for node,pairs in sorted(workers.items())},
            'session_evidence':session_evidence(rows),
            'by_session_familiarity':{name:summarize(pairs) for name,pairs in sessions.items()},
            'note':'Fixed descriptive slices, not tuning or promotion gates. Familiarity is relative to fitted training sessions, not proof of independent traffic or matching profile eras. Worker IDs remain private audit data; request/session IDs are not emitted.'}


def remaining_age_support(training_rows, rows):
    """Count distinct completed training jobs observed at least this far along.

    A hundred progress points from one long job are still one job. This is
    observed horizon support, not effective sample size or prediction confidence.
    Missing late progress can undercount support; future labels never enter it.
    """
    valid=lambda age:type(age) in (int,float) and math.isfinite(age) and age>=0
    maxima={};workers={}
    for row in training_rows:
        age=row['features'].get('elapsed_s')
        if not valid(age):continue
        key=(row['run_id'],row['request_id'])
        maxima[key]=max(maxima.get(key,0),age)
        local=workers.setdefault(row['node'],{})
        local[key]=max(local.get(key,0),age)
    fleet=sorted(maxima.values());local={node:sorted(values.values()) for node,values in workers.items()}
    scopes={name:{band:[] for band in ('none','one','two_to_nine','ten_plus','unknown')} for name in ('fleet','same_worker')}
    for row in rows:
        age=row['features'].get('elapsed_s');key=(row['run_id'],row['request_id'])
        for name,index in [('fleet',fleet),('same_worker',local.get(row['node'],[]))]:
            support=len(index)-bisect.bisect_left(index,age) if valid(age) else None
            band='unknown' if support is None else 'none' if support==0 else 'one' if support==1 else 'two_to_nine' if support<10 else 'ten_plus'
            scopes[name][band].append((key,support))
    result={}
    for name,bands in scopes.items():
        result[name]={}
        for band,points in bands.items():
            counts=[count for _,count in points if count is not None]
            result[name][band]={'points':len(points),'requests':len({key for key,_ in points}),
                               'support_min':min(counts) if counts else None,'support_max':max(counts) if counts else None}
    return {'schema':1,'basis':'completed_training_observed_progress','scopes':result,
            'note':'Completed training jobs only; missing late progress can undercount support. Same worker is not proof of matching hardware/profile era. Bands can share requests; counts are not confidence, independence, promotion or routing authority.'}


def freeze(candidate_path,training_path,receipt_path,*,completion=False):
    candidate,ch=read_json(candidate_path);training,th=read_json(training_path)
    contracts(candidate,training,completion=completion)
    now=dt.datetime.now(dt.timezone.utc).isoformat()
    if max(timestamp(candidate['created_at']),timestamp(training['snapshot']['created_at']))>timestamp(now):
        raise ValueError('Candidate or training snapshot is dated in the future')
    receipt={'schema':1,'purpose':'offline_completion_future_audit' if completion else 'offline_occupancy_future_audit','frozen_at':now,
             'candidate_sha256':ch,'training_sha256':th,'routing_enabled':False}
    fd=os.open(receipt_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(receipt,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    return receipt


def evaluate(candidate_path,training_path,receipt_path,prepared_path,*,completion=False):
    candidate,ch=read_json(candidate_path);training,th=read_json(training_path)
    receipt,_=read_json(receipt_path);prepared,ph=read_json(prepared_path)
    contracts(candidate,training,completion=completion)
    purpose='offline_completion_future_audit' if completion else 'offline_occupancy_future_audit'
    if receipt.get('schema')!=1 or receipt.get('purpose')!=purpose or receipt.get('routing_enabled') is not False or receipt.get('candidate_sha256')!=ch or receipt.get('training_sha256')!=th:
        raise ValueError('Frozen artifact identity changed')
    cutoff=timestamp(receipt['frozen_at']);end=timestamp(prepared['snapshot']['created_at'])
    if cutoff<max(timestamp(candidate['created_at']),timestamp(training['snapshot']['created_at'])) or end<cutoff:
        raise ValueError('Audit evidence predates the freeze')
    if prepared.get('schema')!=training['schema'] or prepared.get('feature_schema')!=training.get('feature_schema') or prepared['snapshot']['feature_builder_sha256']!=training['snapshot']['feature_builder_sha256'] or prepared['snapshot']['hashes']['worker-inventory.json']!=training['snapshot']['hashes']['worker-inventory.json']:
        raise ValueError('Future feature builder or worker profiles changed')
    for data in (training,prepared):
        rows=data.get('rows')
        if not isinstance(rows,list) or len(rows)>100000:raise ValueError('Invalid audit row budget')
        for r in rows:
            if data['schema']=='dsg-occupancy-v2' and any(key in r.get('features',{}) for key in ('prior_generation_tps','worker_generation_tps','history_generation_estimate_s')):
                raise ValueError('Legacy generation anchor in delivery-aware contract')
            wrong_target=any(k in r for k in ('target_contract','terminal_class')) if completion else r.get('target_contract')!='observed_terminal_occupancy' or r.get('terminal_class') not in ('normal','output_limited')
            if wrong_target or any(type(r.get(k)) not in (int,float) or not math.isfinite(r[k]) for k in ('decision_time','finish_time','target_s')) or r['target_s']<0 or r['finish_time']<r['decision_time']:
                raise ValueError('Invalid forecast label for audit target')
    result={'schema':1,'mode':'offline_frozen_completion_future' if completion else 'offline_frozen_occupancy_future','authority':'none','routing_enabled':False,
            'frozen_at':receipt['frozen_at'],'evidence_through':prepared['snapshot']['created_at'],
            'candidate_sha256':ch,'prepared_sha256':ph,'reports':{},
            'note':'Frozen-model replay, not logged live predictions or a measured routing benefit. No promotion authority.'}
    seen={(r['run_id'],r['request_id']) for r in training['rows']}
    first={}
    for r in prepared['rows']:
        key=(r['run_id'],r['request_id']);first[key]=min(first.get(key,float('inf')),r['decision_time'])
    for kind,model in candidate['models'].items():
        # Do not count later progress on already-admitted or previously labeled
        # jobs as independent new traffic.
        rows=[r for r in prepared['rows'] if r['kind']==kind and cutoff<r['decision_time']<=r['finish_time']<=end and first[(r['run_id'],r['request_id'])]>cutoff and (r['run_id'],r['request_id']) not in seen]
        tr,_=split([r for r in training['rows'] if r['kind']==kind],candidate['reports'][kind]['cutoff'])
        report={'status':'no_future_labels','target_coverage':target_coverage(rows),
                'input_support':input_support(model,tr,rows,training.get('groups',{}).get('hardware',[]),training.get('groups',{}))};result['reports'][kind]=report
        report['future_strata']=future_strata(tr,[],[])
        if kind=='updated':report['paired_stages']=updated_stage_pairs([],[],completion=completion)
        if kind=='remaining':report['age_support']=remaining_age_support(tr,rows)
        if not rows:
            if kind=='remaining':report['by_elapsed']=elapsed_slices(tr,[],[])
            continue
        if not tr:raise ValueError('Frozen training partition is empty')
        predictions=[exported_prediction(model,r['features']) for r in rows]
        if any(not math.isfinite(p) for p in predictions):raise ValueError('Non-finite prediction')
        if kind=='updated':report['paired_stages']=updated_stage_pairs(rows,predictions,completion=completion)
        report['future_strata']=future_strata(tr,rows,predictions)
        report.update(status='observed_not_promoted',metrics=metrics(rows,predictions),baselines=baseline(tr,rows)[0])
        if not completion:
            report['terminal_classes']={label:metrics([r for r in rows if r['terminal_class']==label],[p for r,p in zip(rows,predictions) if r['terminal_class']==label])
                if any(r['terminal_class']==label for r in rows) else None for label in ('normal','output_limited')}
        if kind=='remaining':report['by_elapsed']=elapsed_slices(tr,rows,predictions)
        # The updated model is called both after upload and after embeddings.
        # Keep those causal stages visible rather than hiding one behind an average.
        report['by_stage']={}
        for stage in ('admission','upload','embedded','remaining'):
            pairs=[(row,p) for row,p in zip(rows,predictions) if row.get('stage',row['kind'])==stage]
            if pairs:
                points,estimates=map(list,zip(*pairs))
                report['by_stage'][stage]={'metrics':metrics(points,estimates),'baselines':baseline(tr,points)[0]}
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=('freeze','evaluate'))
    for name in ('candidate','training','receipt'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--prepared')
    parser.add_argument('--completion',action='store_true',help='Explicit V2/V3/V4 normal-completion audit; never occupancy or promotion')
    args=parser.parse_args()
    if args.mode=='evaluate' and not args.prepared:parser.error('evaluate requires --prepared')
    try:
        result=freeze(args.candidate,args.training,args.receipt,completion=args.completion) if args.mode=='freeze' else evaluate(args.candidate,args.training,args.receipt,args.prepared,completion=args.completion)
        print(json.dumps(result,allow_nan=False))
    except (ValueError,KeyError,TypeError,OSError) as error:
        parser.exit(1,'Forecast audit rejected: '+type(error).__name__+'\n')
