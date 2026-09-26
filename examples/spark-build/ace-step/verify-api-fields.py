"""Exercise the real pinned parser/model/parameter assembly, without loading GPUs.

Loads the actual GenerationParams/GenerationConfig dataclass definitions from
inference.py via AST to avoid importing Torch or starting models during a build.
This proves parameter wiring only, not native synthesis or audio fidelity.
"""
import ast
import dataclasses
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
        return {'state':'verified','checks':checks,'omitted_defaults':{k:getattr(native_defaults,k) for k in ('sampler_mode','dcw_enabled')},
                'scope':'Actual pinned request parser/model and generation parameter assembly; no GPU inference performed.'}
    finally:
        for key in set(sys.modules)-set(saved_modules):
            if key.startswith(('sg_recipe_', 'acestep.')):sys.modules.pop(key,None)
        for key,value in saved_modules.items():
            if key.startswith('acestep.'):sys.modules[key]=value


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1] if len(sys.argv)==2 else '/opt/ace-step')))
