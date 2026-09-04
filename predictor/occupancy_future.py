"""Frozen-model future audit. Offline only; never promotes or changes routing."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import stat

from fit_v2 import baseline, exported_prediction, metrics, split, target_coverage


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


def contracts(candidate,training):
    if candidate.get('schema')!=2 or candidate.get('feature_schema')!='dsg-occupancy-v1' or candidate.get('routing_enabled') is not False:
        raise ValueError('Only offline occupancy candidates are supported')
    if training.get('schema')!='dsg-occupancy-v1' or training.get('feature_schema')!='dsg-latency-v4' or candidate.get('snapshot')!=training.get('snapshot'):
        raise ValueError('Training snapshot does not match the frozen candidate')
    if not candidate.get('models') or any(k not in ('admission','updated','remaining') for k in candidate['models']):
        raise ValueError('Unsupported occupancy model kinds')


def freeze(candidate_path,training_path,receipt_path):
    candidate,ch=read_json(candidate_path);training,th=read_json(training_path)
    contracts(candidate,training)
    now=dt.datetime.now(dt.timezone.utc).isoformat()
    if max(timestamp(candidate['created_at']),timestamp(training['snapshot']['created_at']))>timestamp(now):
        raise ValueError('Candidate or training snapshot is dated in the future')
    receipt={'schema':1,'purpose':'offline_occupancy_future_audit','frozen_at':now,
             'candidate_sha256':ch,'training_sha256':th,'routing_enabled':False}
    fd=os.open(receipt_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(receipt,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    return receipt


def evaluate(candidate_path,training_path,receipt_path,prepared_path):
    candidate,ch=read_json(candidate_path);training,th=read_json(training_path)
    receipt,_=read_json(receipt_path);prepared,ph=read_json(prepared_path)
    contracts(candidate,training)
    if receipt.get('schema')!=1 or receipt.get('purpose')!='offline_occupancy_future_audit' or receipt.get('routing_enabled') is not False or receipt.get('candidate_sha256')!=ch or receipt.get('training_sha256')!=th:
        raise ValueError('Frozen artifact identity changed')
    cutoff=timestamp(receipt['frozen_at']);end=timestamp(prepared['snapshot']['created_at'])
    if cutoff<max(timestamp(candidate['created_at']),timestamp(training['snapshot']['created_at'])) or end<cutoff:
        raise ValueError('Audit evidence predates the freeze')
    if prepared.get('schema')!='dsg-occupancy-v1' or prepared.get('feature_schema')!='dsg-latency-v4' or prepared['snapshot']['feature_builder_sha256']!=training['snapshot']['feature_builder_sha256'] or prepared['snapshot']['hashes']['worker-inventory.json']!=training['snapshot']['hashes']['worker-inventory.json']:
        raise ValueError('Future feature builder or worker profiles changed')
    for data in (training,prepared):
        rows=data.get('rows')
        if not isinstance(rows,list) or len(rows)>100000:raise ValueError('Invalid audit row budget')
        for r in rows:
            if r.get('target_contract')!='observed_terminal_occupancy' or r.get('terminal_class') not in ('normal','output_limited') or any(not isinstance(r.get(k),(int,float)) or not math.isfinite(r[k]) for k in ('decision_time','finish_time','target_s')) or r['target_s']<0 or r['finish_time']<r['decision_time']:
                raise ValueError('Invalid occupancy label')
    result={'schema':1,'mode':'offline_frozen_occupancy_future','authority':'none','routing_enabled':False,
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
        report={'status':'no_future_labels','target_coverage':target_coverage(rows)};result['reports'][kind]=report
        if not rows:continue
        if not tr:raise ValueError('Frozen training partition is empty')
        predictions=[exported_prediction(model,r['features']) for r in rows]
        if any(not math.isfinite(p) for p in predictions):raise ValueError('Non-finite prediction')
        report.update(status='observed_not_promoted',metrics=metrics(rows,predictions),baselines=baseline(tr,rows)[0],
            terminal_classes={label:metrics([r for r in rows if r['terminal_class']==label],[p for r,p in zip(rows,predictions) if r['terminal_class']==label])
                if any(r['terminal_class']==label for r in rows) else None for label in ('normal','output_limited')})
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=('freeze','evaluate'))
    for name in ('candidate','training','receipt'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--prepared')
    args=parser.parse_args()
    if args.mode=='evaluate' and not args.prepared:parser.error('evaluate requires --prepared')
    try:
        result=freeze(args.candidate,args.training,args.receipt) if args.mode=='freeze' else evaluate(args.candidate,args.training,args.receipt,args.prepared)
        print(json.dumps(result,allow_nan=False))
    except (ValueError,KeyError,TypeError,OSError) as error:
        parser.exit(1,'Occupancy audit rejected: '+type(error).__name__+'\n')
