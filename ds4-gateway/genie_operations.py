"""Genie proposal/status tools; no approval, cancellation or server-control tool."""
import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
from genie_inspection import scrub

TOOLSET = 'stargate_operations'
NAMES = {'propose_server_change','server_change_status'}


def register_operations(config, emit):
    from tools.registry import registry
    url = urllib.parse.urlsplit(config['url'])
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/api/genie/operation-tools' or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private operation proposal endpoint')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def run(name,args):
        at=datetime.now(timezone.utc).isoformat()
        event={'tool':name,'id':args.get('id'),'at':at}
        emit('operation',event={**event,'state':'reading','request':scrub(args)})
        try:
            payload = {'action':'propose','proposal':args,'origin':config.get('origin',{})} if name == 'propose_server_change' else ({'action':'status','id':args['id']} if args.get('id') else {'action':'list'})
            request = urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={
                'Content-Type':'application/json','X-SG-Operation-Tool':config['token']})
            with opener.open(request,timeout=30) as response:
                raw = response.read(1048577)
                if len(raw)>1048576: raise ValueError('Operation status too large')
                result = json.loads(raw)
            emit('operation',event={**event,'state':'complete','finished_at':datetime.now(timezone.utc).isoformat(),'result':result})
            return json.dumps(result)
        except Exception as error:
            if isinstance(error,urllib.error.HTTPError):error.close()
            emit('operation',event={**event,'state':'failed','finished_at':datetime.now(timezone.utc).isoformat()})
            return json.dumps({'error':'Operation request could not be confirmed. Check server_change_status using the same operation ID before proposing anything again. No approval was granted by this tool.'})
    proposal={'type':'object','properties':{'id':{'type':'string','description':'A new UUID for this exact proposal. Reuse it when checking an uncertain submission.'},
        'worker_id':{'type':'string','enum':config['workers']},'image':{'type':'string','pattern':'^sha256:[a-f0-9]{64}$'},
        'command':{'type':'array','items':{'type':'string'},'description':'Complete reviewed serving arguments as separate strings, at most 65536 JSON bytes; preserve unrelated settings.'},'reason':{'type':'string','minLength':1,'maxLength':2000},
        'trial':{'type':'boolean','description':'Set true for an experiment: qualify the candidate, measure it with the enrolled one-hour Hourglass run, then restore and qualify the original even if the candidate passes. No automatic adoption. Omit for the existing apply-and-qualify change.'}},
        'required':['id','worker_id','image','command','reason'],'additionalProperties':False}
    for name,description,parameters in [
        ('propose_server_change','Prepare a serving change for owner review. First inspect the current full configuration and available image. This never approves, drains or starts a server. The owner approves the exact prepared plan in the gateway UI.',proposal),
        ('server_change_status','Read saved proposal and execution evidence: retained serving version, published configuration revisions, qualification and gateway readmission when recorded. Match those revisions to Hourglass report associations. These are dated receipts, not current health or a measured speed improvement. Omit id to list changes. Never resubmit an uncertain operation.',{'type':'object','properties':{'id':{'type':'string'}},'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},
            handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=1048576)
    return NAMES
