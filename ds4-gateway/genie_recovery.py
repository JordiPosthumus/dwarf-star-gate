"""Chat access to the existing enrolled-service recovery controller."""
import json
import uuid
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
TOOLSET='stargate_recovery'
NAMES={'recovery_status','recover_server','prepare_pair_recovery','enroll_pair_recovery','qualify_pair_recovery','qualify_omlx_recovery','enroll_omlx_recovery'}


def register_recovery(config,emit):
    from tools.registry import registry
    url=urllib.parse.urlsplit(config['url'])
    if (url.scheme!='http' or url.hostname!='127.0.0.1' or not url.port or url.path!='/api/genie/recovery-tools'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private recovery tool endpoint')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def run(name,args):
        # The bridge creates and reports the handle before sending exactly once.
        action_id=str(uuid.uuid4()) if name in ('recover_server', 'prepare_pair_recovery', 'enroll_pair_recovery','qualify_pair_recovery','qualify_omlx_recovery','enroll_omlx_recovery') else None
        event={'tool':name,'at':datetime.now(timezone.utc).isoformat(),'request':args,'action_id':action_id}
        emit('recovery',event={**event,'state':'reading'})
        try:
            payload={'action':'status'} if name=='recovery_status' else {**args,'action':'prepare-pair' if name=='prepare_pair_recovery' else 'enroll-pair' if name=='enroll_pair_recovery' else 'qualify-omlx' if name=='qualify_omlx_recovery' else 'qualify-pair' if name=='qualify_pair_recovery' else 'enroll-omlx' if name=='enroll_omlx_recovery' else 'recover','action_id':action_id}
            request=urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-SG-Recovery-Tool':config['token']})
            with opener.open(request,timeout=15) as response:
                raw=response.read(262145)
                if len(raw)>262144:raise ValueError('Recovery status too large')
                result=json.loads(raw)
            emit('recovery',event={**event,'state':'complete','finished_at':datetime.now(timezone.utc).isoformat(),'result':result})
            return json.dumps(result)
        except Exception as error:
            message='Recovery request could not be confirmed. Read recovery_status for the same action ID; never repeat the request or claim it succeeded.'
            if isinstance(error,urllib.error.HTTPError):
                try:message=json.loads(error.read(4096)).get('error',message)
                except (ValueError,OSError):pass
                finally:error.close()
            emit('recovery',event={**event,'state':'failed','finished_at':datetime.now(timezone.utc).isoformat(),'error':message})
            return json.dumps({'error':message,'action_id':action_id,'next_step':'Read recovery_status and find this action ID; do not issue another recovery for the same fault.'})
    for name,description,parameters in [
        ('enroll_omlx_recovery','Capture and enroll one explicitly opted-in existing local GLM/oMLX installation. Uses only its configured launcher and dependencies, preserves native process/settings, and returns one durable action ID. Read recovery_status.omlx_enrollment.operations; enrollment does not restart or qualify recovery. Never replay uncertain work.',{'type':'object','properties':{'worker_id':{'type':'string'}},'required':['worker_id'],'additionalProperties':False}),
        ('qualify_omlx_recovery','Qualify an explicitly opted-in idle healthy local GLM/oMLX worker using its current omlx_qualification evidence_id from recovery_status. Preserves the enrolled existing launcher and settings, holds later requests in the queue, and requires native GLM generation/cache proof before readmission. Another physical LLM must remain available for restart. Preserve the action ID and read operations once; the completion watcher follows the same action. Never replay uncertain work or override an owner pause. Does not grant stopped-start authority.',{'type':'object','properties':{'worker_id':{'type':'string'},'evidence_id':{'type':'string'}},'required':['worker_id','evidence_id'],'additionalProperties':False}),
        ('qualify_pair_recovery','Qualify recovery for an explicitly opted-in idle healthy pair using its current pair_qualification evidence_id from recovery_status. Restarts only pinned existing containers while another physical LLM remains available, verifies native generation/cache reuse, and restores service only if no owner pause or hold intervenes. Preserve the action ID; observe operations in recovery_status. Never replay uncertain work.',{'type':'object','properties':{'worker_id':{'type':'string'},'evidence_id':{'type':'string'}},'required':['worker_id','evidence_id'],'additionalProperties':False}),
        ('enroll_pair_recovery','Enroll one explicitly opted-in pair from an existing prepared capture ID. Fixed native validation preserves exact identities, settings and capacity. Returns a durable action ID; observe recovery_status.pair_enrollment.operations. Does not restart, pause or qualify recovery. Never replay an uncertain request.',{'type':'object','properties':{'worker_id':{'type':'string'},'capture_id':{'type':'string'}},'required':['worker_id','capture_id'],'additionalProperties':False}),
        ('prepare_pair_recovery','Capture current native identities, exact Docker definitions and mounted-file hashes for an existing configured GLM pair. Reads both members twice and retains evidence privately. Does not enroll recovery, run inference, restart, pause or change settings. Returns an action ID promptly; observe its pair_preparations entry in recovery_status. Prepared is inspection evidence only, not restart qualification or mutation authority. Do not replay an uncertain request.',{'type':'object','properties':{'worker_id':{'type':'string'}},'required':['worker_id'],'additionalProperties':False}),
        ('recovery_status','Read fresh recovery policy, service enrollment, worker eligibility and recent operation receipts. Use before recovery and to follow an accepted or uncertain action. A switch on does not mean the service is connected. Eligibility concerns the observed fault now. no_supported_quarantine means there is no currently supported quarantine trigger; it does not by itself mean recovery is disabled or disconnected. Check matched enrollment and start_stopped_enrolled separately before describing stopped-service recovery. A healthy running service can be correctly enrolled while no recovery is presently needed.',{'type':'object','properties':{},'additionalProperties':False}),
        ('recover_server','Request existing recovery for one currently eligible worker using its exact evidence_id from recovery_status. The recovery toggle authorizes eligible requests; no per-request approval is needed. Cannot enroll services, change settings, run canaries or interrupt active jobs. Returns an operation receipt, not proof of completion. Never replay an uncertain request.',{'type':'object','properties':{k:{'type':'string'} for k in ['worker_id','evidence_id']},'required':['worker_id','evidence_id'],'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=262144)
    return NAMES
