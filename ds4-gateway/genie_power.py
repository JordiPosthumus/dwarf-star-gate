"""Chat access to the enrolled fleet power scripts via the dashboard tool endpoint."""
import json
import urllib.error
import urllib.parse
import urllib.request
TOOLSET='stargate_fleet_power'
NAMES={'fleet_power_status','fleet_power','fleet_routing','fleet_recipe_trial','fleet_recipe_rollout'}


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
            if name=='fleet_power_status':payload={'action':'status'}
            elif name=='fleet_recipe_trial':payload={'action':'recipe-trial','profile':args['profile'],'stage':args['stage'],'trial_id':args['trial_id']}
            elif name=='fleet_recipe_rollout':payload={'action':'recipe-rollout','profile':args['profile'],'rollout_id':args['rollout_id'],**({'expected_finished_at':args['expected_finished_at']} if 'expected_finished_at' in args else {})}
            elif name=='fleet_routing':payload={'action':'routing','worker':args['worker'],'routing_action':args['routing_action'],'action_id':args['action_id'],**({'expected_operator_action':args['expected_operator_action']} if 'expected_operator_action' in args else {})}
            else:payload={'action':'power','worker':args['worker'],'power_action':args['power_action'],'action_id':args['action_id']}
            request=urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-SG-Power-Tool':config['token']})
            with opener.open(request,timeout=30) as response:
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
        ('fleet_recipe_rollout','Permanently deploy an exact operator-enrolled Spark recipe after explicit owner authorization. This is not a benchmark or a temporary trial: it copies the previously qualified image, preserves the target serving limits and precision, backs up the original containers/launch configuration, holds only the target pair, waits for existing work, starts the candidate, verifies readiness, updates the persistent launcher and conditionally readmits. The original remains available for rollback. Preparation and deployment run independently after acceptance; read fleet_power_status recipe_trials for the same rollout ID. Never reissue uncertainty with a new ID or claim completion from narration. Only after a confirmed failed copying_qualified_image stage, after addressing its cause, expected_finished_at may resume that same operation. Supply its exact finished_at receipt. Running, uncertain or advanced preparations cannot resume; old failure evidence remains retained.',{'type':'object','properties':{'profile':{'type':'string'},'rollout_id':{'type':'string'},'expected_finished_at':{'type':'number'}},'required':['profile','rollout_id'],'additionalProperties':False}),
        ('fleet_recipe_trial','Run a pre-enrolled, immutable owner-approved recipe qualification. Use the exact profile ID provided by the owner/operator. prepare backs up and verifies the original; Spark profiles also build an isolated candidate while serving remains running. run reserves only its enrolled worker, waits for gateway/native work, executes the enrolled protocol (candidate-only correctness/cache/capacity acceptance or an A/B/A2 comparison), restores the original containers or exact local settings and conditionally readmits. The profile fixes the protocol; chat cannot change it. Never adopt a candidate or change the plan. Use the existing explicit approval for this exact temporary profile; otherwise ask first. Use the SAME trial_id for prepare and run. Preparation must be complete before run. Returns promptly; read fleet_power_status recipe_trials for durable status. Never reissue an uncertain stage with a new ID.',{'type':'object','properties':{'profile':{'type':'string'},'stage':{'type':'string','enum':['prepare','run']},'trial_id':{'type':'string'}},'required':['profile','stage','trial_id'],'additionalProperties':False}),
        ('fleet_routing','For an owner-approved lifecycle action, drain or resume one enrolled worker through the existing core controls. Drain stops new routing and lets admitted work finish; never stops a model. Keep a separate healthy LLM. Save the returned operator_action ID; resume requires that exact expected_operator_action so a later owner pause is preserved. If was_drained is true, preserve that preexisting pause unless explicitly authorized otherwise. Use fleet_power_status to inspect routing receipts after uncertainty. Never repeat an action ID with different arguments.',{'type':'object','properties':{'worker':{'type':'string'},'routing_action':{'type':'string','enum':['drain','resume']},'action_id':{'type':'string'},'expected_operator_action':{'type':['string','null']}},'required':['worker','routing_action','action_id'],'additionalProperties':False}),
        ('fleet_power_status','Read enrolled power scripts, current gateway routing per member and recent script receipts. Use before any start or stop. Gateway health does not prove the model process is running; the status script does.',{'type':'object','properties':{},'additionalProperties':False}),
        ('fleet_power','Run one enrolled script: status, start or stop for one exact worker. Use the owner approval already present in this conversation when it covers this exact action; otherwise ask BEFORE stopping or starting. Read-only status needs no approval. Before a stop: use fleet_routing to drain the worker (then wait for load 0 and queued 0), never stop the last healthy LLM. The receipt is a script exit, not readiness or shutdown proof; follow up with fleet_power_status.',{'type':'object','properties':{'worker':{'type':'string'},'power_action':{'type':'string','enum':['status','start','stop']},'action_id':{'type':'string'}},'required':['worker','power_action','action_id'],'additionalProperties':False})]:
        registry.register(name=name,toolset=TOOLSET,schema={'name':name,'description':description,'parameters':parameters},handler=lambda args,_name=name,**kw:run(_name,args),max_result_size_chars=262144)
    return NAMES
