"""Exercise the real pinned parser/model/parameter assembly, without loading GPUs.

Loads the actual GenerationParams/GenerationConfig dataclass definitions from
inference.py via AST to avoid importing Torch or starting models during a build.
This proves parameter wiring only, not native synthesis or audio fidelity.
"""
import ast
import dataclasses
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import typing


def verify(root):
    root = Path(root)
    saved_modules = dict(sys.modules)
    def load(name, relative):
        spec = importlib.util.spec_from_file_location(name, root / relative)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    try:
        constants = load('acestep.constants', 'acestep/constants.py')
        module = types.ModuleType('acestep.inference')
        module.__dict__.update(vars(typing));module.__dict__.update(vars(constants))
        module.__dict__.update(dataclass=dataclasses.dataclass, field=dataclasses.field, asdict=dataclasses.asdict)
        # Keep the class module identity stable for dataclasses' annotation logic.
        module.__name__ = 'acestep.inference'
        sys.modules['acestep.inference'] = module
        source = ast.parse((root / 'acestep/inference.py').read_text())
        definitions = [n for n in source.body if isinstance(n, ast.ClassDef) and n.name in ('GenerationParams', 'GenerationConfig')]
        assert len(definitions) == 2
        exec(compile(ast.Module(body=definitions, type_ignores=[]), 'pinned-generation-classes', 'exec'), module.__dict__)
        parser = load('sg_recipe_parser', 'acestep/api/http/release_task_param_parser.py')
        model = load('sg_recipe_model', 'acestep/api/http/release_task_models.py')
        builder = load('sg_recipe_builder', 'acestep/api/http/release_task_request_builder.py')
        assembly = load('sg_recipe_assembly', 'acestep/api/job_generation_setup.py')
        def request(payload):
            return builder.build_generate_music_request(parser.RequestParser(payload), model.GenerateMusicRequest,
                constants.DEFAULT_DIT_INSTRUCTION, .85, 2.0, .9)
        def generate(payload):
            req = request(payload)
            return assembly.build_generation_setup(req=req, caption=req.prompt, lyrics=req.lyrics,
                bpm=req.bpm, key_scale=req.key_scale, time_signature=req.time_signature, audio_duration=req.audio_duration,
                thinking=req.thinking, sample_mode=req.sample_mode, format_has_duration=False,
                use_cot_caption=req.use_cot_caption, use_cot_language=req.use_cot_language,
                lm_top_k=req.lm_top_k, lm_top_p=req.lm_top_p,
                parse_timesteps=lambda _:None, is_instrumental=lambda _:False,
                default_dit_instruction=constants.DEFAULT_DIT_INSTRUCTION, task_instructions={})
        checks = 0
        defaults = generate({})
        native_defaults = module.GenerationParams()
        for key in ('sampler_mode', 'dcw_enabled'):
            assert getattr(defaults.params, key) == getattr(native_defaults, key);checks += 1
        base = {'caption':'Recipe boundary fixture', 'lyrics':'[Verse]\nOriginal words', 'thinking':True,
                'inference_steps':80, 'guidance_scale':3.0, 'audio_duration':-1, 'batch_size':1,
                'seed':11, 'use_random_seed':False, 'audio_format':'flac', 'infer_method':'ode',
                'sampler_mode':'heun', 'dcw_enabled':False}
        omitted = generate({k:v for k,v in base.items() if k not in ('sampler_mode','dcw_enabled')})
        explicit = generate(base)
        expected = {**dataclasses.asdict(omitted.params), 'sampler_mode':'heun', 'dcw_enabled':False}
        assert dataclasses.asdict(explicit.params) == expected;checks += 1
        assert dataclasses.asdict(explicit.config) == dataclasses.asdict(omitted.config);checks += 1
        for payload in (base, {'param_obj':json.dumps(base)}, {'metadata':base}):
            result = generate(payload)
            for name,value in {'caption':base['caption'],'lyrics':base['lyrics'],'thinking':True,
                               'inference_steps':80,'guidance_scale':3.0,'duration':-1.0,
                               'sampler_mode':'heun','dcw_enabled':False,'infer_method':'ode'}.items():
                assert getattr(result.params,name) == value, name;checks += 1
            for name,value in {'seeds':[11],'use_random_seed':False,'batch_size':1,'audio_format':'flac'}.items():
                assert getattr(result.config,name) == value, name;checks += 1
        for sampler in ('euler','heun'):
            for dcw in (True,False):
                result=generate({**base,'sampler_mode':sampler,'dcw_enabled':dcw,'thinking':False})
                assert (result.params.sampler_mode,result.params.dcw_enabled,result.params.thinking)==(sampler,dcw,False);checks += 1
        nested=generate({'sampler_mode':'euler','dcw_enabled':True,'param_obj':base})
        assert nested.params.sampler_mode=='euler' and nested.params.dcw_enabled is True;checks += 1
        for field,value in [('sampler_mode','unsupported'),('sampler_mode',0),('sampler_mode',False),('dcw_enabled','perhaps')]:
            try: request({field:value})
            except ValueError: checks += 1
            else: raise AssertionError('Invalid explicit recipe option accepted: '+field)
        # Verify metadata from the generator's returned audio objects rather
        # than reconstructing effective values from the submitted request.
        response_module = load('sg_recipe_result', 'acestep/api/job_result_payload.py')
        cache_module = load('sg_recipe_cache', 'acestep/api/jobs/local_cache_updates.py')
        query_module = load('sg_recipe_query', 'acestep/api/http/query_result_service.py')
        generated = [dict(dataclasses.asdict(explicit.params), seed=seed, audio_format='flac',
                          caption='Generator caption '+str(seed), lora_loaded=False,
                          use_lora=False, lora_scale=1.0, lora_weights_hash=None)
                     for seed in (11, 12)]
        audio_rows = [{'path':'/output/sample-'+str(i)+'.flac','params':v} for i,v in enumerate(generated)]
        payload = response_module.build_generation_success_response(
            result=types.SimpleNamespace(audios=audio_rows, extra_outputs={}, status_message='success'),
            params=explicit.params, bpm=80, audio_duration=-1, key_scale=None, time_signature=None,
            original_prompt='Requested caption', original_lyrics='Requested lyrics', inference_steps=80,
            path_to_audio_url=lambda name:'/v1/audio?path='+name, build_generation_info=lambda **kw:'info',
            lm_model_name='fixture-lm', dit_model_name='fixture-dit')
        assert len(payload['generation_receipts'])==2;checks+=1
        record=types.SimpleNamespace(result=payload,status='succeeded',created_at=1,progress_text='done',env='fixture')
        store=types.SimpleNamespace(get=lambda task:record)
        cache_data={}
        class Cache:
            def get(self,key):return cache_data.get(key)
            def set(self,key,value,ex):cache_data[key]=json.dumps(value)
        cache=Cache()
        cache_module.update_local_cache(cache,store,'fixture',payload,'succeeded',lambda _:1,'result:',3600)
        for selected_cache in (cache,None):
            rows=query_module.collect_query_results(['fixture'],selected_cache,store,lambda _:1,'result:',3600,lambda:'')
            assert rows[0]['task_id']=='fixture' and rows[0]['status']==1;checks+=1
            audios=json.loads(rows[0]['result']);assert len(audios)==2;checks+=1
            for i,audio in enumerate(audios):
                receipt=audio['generation_receipt']
                assert audio['file']==payload['audio_paths'][i];checks+=1
                assert receipt['schema']==1 and receipt['source']=='acestep.inference.audio.params';checks+=1
                assert receipt['parameters']==generated[i];checks+=1
                assert receipt['reported_models']=={'lm':'fixture-lm','dit':'fixture-dit'};checks+=1
        # A response snapshot cannot change if later code mutates an audio row.
        audio_rows[0]['params']['sampler_mode']='changed-after-response'
        assert payload['generation_receipts'][payload['audio_paths'][0]]['parameters']['sampler_mode']=='heun';checks+=1
        # Old/analysis/failed results do not acquire invented generation proof.
        legacy={k:v for k,v in payload.items() if k!='generation_receipts'}
        record.result=legacy
        cache_module.update_local_cache(cache,store,'fixture',legacy,'succeeded',lambda _:1,'result:',3600)
        for selected_cache in (cache,None):
            rows=query_module.collect_query_results(['fixture'],selected_cache,store,lambda _:1,'result:',3600,lambda:'')
            assert all('generation_receipt' not in row for row in json.loads(rows[0]['result']));checks+=1
        files=['acestep/constants.py','acestep/inference.py','acestep/api/http/release_task_param_parser.py',
               'acestep/api/http/release_task_models.py','acestep/api/http/release_task_request_builder.py','acestep/api/job_generation_setup.py',
               'acestep/api/job_result_payload.py','acestep/api/http/query_result_service.py','acestep/api/jobs/local_cache_updates.py']
        return {'schema':2,'state':'verified','checks':checks,
                'generation_receipt':{'schema':1,'source':'acestep.inference.audio.params','per_audio':True,'query_paths':['cache','store']},
                'supported':{'sampler_mode':['euler','heun'],'dcw_enabled':[True,False]},
                'source_sha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files},
                'omitted_defaults':{k:getattr(native_defaults,k) for k in ('sampler_mode','dcw_enabled')},
                'scope':'Actual pinned parameter assembly and per-audio result serialization through cache/store paths; no GPU inference performed.'}
    finally:
        for key in set(sys.modules)-set(saved_modules):
            if key.startswith(('sg_recipe_', 'acestep.')):sys.modules.pop(key,None)
        for key,value in saved_modules.items():
            if key.startswith('acestep.'):sys.modules[key]=value


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1] if len(sys.argv)==2 else '/opt/ace-step')))
