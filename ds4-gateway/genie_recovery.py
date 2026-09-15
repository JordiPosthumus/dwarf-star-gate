"""Chat access to the existing enrolled-service recovery controller."""
import json
import uuid
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
TOOLSET='stargate_recovery'
NAMES={'recovery_status','recover_server'}


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
        action_id=str(uuid.uuid4()) if name=='recover_server' else None
        event={'tool':name,'at':datetime.now(timezone.utc).isoformat(),'request':args,'action_id':action_id}
        emit('recovery',event={**event,'state':'reading'})
        try:
            payload={'action':'status'} if name=='recovery_status' else {'action':'recover',**args,'action_id':action_id}
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
        ('recovery_status','Read fresh recovery policy, service enrollment, worker eligibility and recent operation receipts. Use before recovery and to follow an accepted or uncertain action. A switch on does not mean the service is connected.',{'type':'object','properties':{},'additionalProperties':False}),
        ('recover_server','Request existing recovery for one currently eligible worker using its exact evidence_id from recovery_status. The recovery toggle authorizes eligible requests; no per-request approval is needed. Cannot enroll services, change settings, run canaries or interrupt active jobs. Returns an operation receipt, not proof of completion. Never replay an uncertain request.',{'type':'object','properties':{k:{'type':'string'} for k in ['worker_id','evidence_id']},'required':['worker_id','evidence_id'],'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=262144)
    return NAMES
