"""Chat access to fleet admission via the dashboard tool endpoint.

Ask-first by design: admission_inspect is read-only; admission_admit runs one
owner-approved stage at a time. The model must present the proposal and wait
for the owner's agreement in this conversation before every mutating stage."""
import json
import urllib.error
import urllib.parse
import urllib.request
TOOLSET='stargate_admission'
NAMES={'admission_status','admission_inspect','admission_admit'}


def register_admission(config,emit):
    from tools.registry import registry
    url=urllib.parse.urlsplit(config['url'])
    if (url.scheme!='http' or url.hostname!='127.0.0.1' or not url.port or url.path!='/api/genie/admission-tools'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private admission tool endpoint')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def run(name,args):
        event={'tool':name,'at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'request':args}
        emit('admission',event={**event,'state':'reading'})
        try:
            if name=='admission_status':
                payload={'action':'status'}
            elif name=='admission_inspect':
                payload={'action':'inspect','url':args['url'],**({'api_key_file':args['api_key_file']} if args.get('api_key_file') else {})}
            else:
                payload={'action':'admit','stage':args['stage'],'fingerprint':args['fingerprint'],'action_id':args['action_id'],**({'overwrite_route':True} if args.get('overwrite_route') else {})}
            request=urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-SG-Admission-Tool':config['token']})
            with opener.open(request,timeout=200) as response:
                raw=response.read(262145)
                if len(raw)>262144:raise ValueError('Admission result too large')
                result=json.loads(raw)
            emit('admission',event={**event,'state':'complete','finished_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'result':result})
            return json.dumps(result)
        except Exception as error:
            message='Admission request could not be confirmed. Read admission_status for the same action ID; never repeat a mutating stage or claim it succeeded.'
            if isinstance(error,urllib.error.HTTPError):
                try:message=json.loads(error.read(4096)).get('error',message)
                except (ValueError,OSError):pass
                finally:error.close()
            emit('admission',event={**event,'state':'failed','finished_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'error':message})
            return json.dumps({'error':message,'next_step':'Read admission_status and find this action ID; do not re-run the same stage.'})
    for name,description,parameters in [
        ('admission_status','Read the current admission state: last inspection, fingerprint, completed stages and receipts. Use after any unclear admission reply before doing anything else.',{'type':'object','properties':{},'additionalProperties':False}),
        ('admission_inspect','Probe one local loopback model endpoint (GET /v1/models) and draft an admission proposal: worker id, context, model route, dead workers on the same endpoint, and the staged plan. Read-only. Present the proposal to the owner and wait for explicit approval in chat before any admission_admit stage.',{'type':'object','properties':{'url':{'type':'string'},'api_key_file':{'type':'string'}},'required':['url'],'additionalProperties':False}),
        ('admission_admit','Run ONE owner-approved admission stage. Stages in order: remove-dead (only when the proposal lists dead workers), add-worker, route (writes the private config with a backup), restart (parks the core while the Continuity Door holds calls, then spawns the start), verify (door status + canary generation + worker health). Ask the owner in chat BEFORE every stage; the answer in this conversation is the approval. Never chain stages without asking. If verify reports problems, report them honestly and do not claim success.',{'type':'object','properties':{'stage':{'type':'string','enum':['remove-dead','add-worker','route','restart','verify']},'fingerprint':{'type':'string'},'action_id':{'type':'string'},'overwrite_route':{'type':'boolean'}},'required':['stage','fingerprint','action_id'],'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=262144)
    return NAMES
