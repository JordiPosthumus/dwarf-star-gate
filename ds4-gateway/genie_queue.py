"""Conversational queue tools using Star Gate's existing exact-offer executor."""
import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
TOOLSET='stargate_queue'
NAMES={'queue_balance_status','move_waiting_job'}


def register_queue(config,emit):
    from tools.registry import registry
    url=urllib.parse.urlsplit(config['url'])
    if (url.scheme!='http' or url.hostname!='127.0.0.1' or not url.port or url.path!='/api/genie/queue-tools'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private queue tool endpoint')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def run(name,args):
        event={'tool':name,'at':datetime.now(timezone.utc).isoformat(),'request':args}
        emit('queue',event={**event,'state':'reading'})
        try:
            payload={'action':'status'} if name=='queue_balance_status' else {'action':'move',**args}
            request=urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-SG-Queue-Tool':config['token']})
            with opener.open(request,timeout=15) as response:
                raw=response.read(262145)
                if len(raw)>262144:raise ValueError('Queue status too large')
                result=json.loads(raw)
            emit('queue',event={**event,'state':'complete','finished_at':datetime.now(timezone.utc).isoformat(),'result':result})
            return json.dumps(result)
        except Exception as error:
            message='Queue request could not be confirmed. Read queue_balance_status before doing anything else. Do not repeat an uncertain move or claim it succeeded.'
            if isinstance(error,urllib.error.HTTPError):
                try:message=json.loads(error.read(4096)).get('error',message)
                except (ValueError,OSError):pass
                finally:error.close()
            emit('queue',event={**event,'state':'failed','finished_at':datetime.now(timezone.utc).isoformat(),'error':message})
            return json.dumps({'error':message,'next_step':'Read fresh queue status. Do not replay the same move.'})
    for name,description,parameters in [
        ('queue_balance_status','Read fresh worker load, waiting jobs, eligibility reasons, exact offered moves and the latest move receipt. No prompt contents. Read this before choosing a move.',{'type':'object','properties':{},'additionalProperties':False}),
        ('move_waiting_job','Move one waiting job using an exact offer from queue_balance_status. This acts immediately when queue balancing is on; no per-move approval is needed. Never invent or alter offer fields. The gateway rechecks eligibility, preserves active jobs, sockets and deadlines, and rejects stale offers. Report success only with a returned receipt.',{'type':'object','properties':{k:{'type':'string'} for k in ['request_id','source','destination','evidence_id']},'required':['request_id','source','destination','evidence_id'],'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=262144)
    return NAMES
