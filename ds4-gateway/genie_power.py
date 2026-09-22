"""Chat access to the enrolled fleet power scripts via the dashboard tool endpoint."""
import json
import urllib.error
import urllib.parse
import urllib.request
TOOLSET='stargate_fleet_power'
NAMES={'fleet_power_status','fleet_power'}


def register_power(config,emit):
    from tools.registry import registry
    url=urllib.parse.urlsplit(config['url'])
    if (url.scheme!='http' or url.hostname!='127.0.0.1' or not url.port or url.path!='/api/genie/power-tools'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private fleet power tool endpoint')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def run(name,args):
        event={'tool':name,'at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'request':args}
        emit('power',event={**event,'state':'reading'})
        try:
            payload={'action':'status'} if name=='fleet_power_status' else {'action':'power','worker':args['worker'],'power_action':args['power_action'],'action_id':args['action_id']}
            request=urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-SG-Power-Tool':config['token']})
            with opener.open(request,timeout=15) as response:
                raw=response.read(262145)
                if len(raw)>262144:raise ValueError('Fleet power status too large')
                result=json.loads(raw)
            emit('power',event={**event,'state':'complete','finished_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'result':result})
            return json.dumps(result)
        except Exception as error:
            message='Fleet power request could not be confirmed. Read fleet_power_status for the same action ID; never repeat the request or claim it succeeded.'
            if isinstance(error,urllib.error.HTTPError):
                try:message=json.loads(error.read(4096)).get('error',message)
                except (ValueError,OSError):pass
                finally:error.close()
            emit('power',event={**event,'state':'failed','finished_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'error':message})
            return json.dumps({'error':message,'next_step':'Read fleet_power_status and find this action ID; do not issue another start/stop for the same worker.'})
    for name,description,parameters in [
        ('fleet_power_status','Read enrolled power scripts, current gateway routing per member and recent script receipts. Use before any start or stop. Gateway health does not prove the model process is running; the status script does.',{'type':'object','properties':{},'additionalProperties':False}),
        ('fleet_power','Run one enrolled script: status, start or stop for one exact worker. Ask the owner in chat BEFORE stopping or starting anything; the answer in this conversation is the approval. Before a stop: drain the worker (it must show load 0 and queued 0), never stop the last healthy LLM. The receipt is a script exit, not readiness or shutdown proof; follow up with fleet_power_status.',{'type':'object','properties':{'worker':{'type':'string'},'power_action':{'type':'string','enum':['start','stop']},'action_id':{'type':'string'}},'required':['worker','power_action','action_id'],'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=262144)
    return NAMES