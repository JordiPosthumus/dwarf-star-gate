"""Small SGUI adapter to native Hermes configuration; never an agent loop."""
import copy, hashlib, json, os, sys, uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

from hermes_cli.config import require_readable_config_before_write, atomic_config_write

home = Path(os.environ["HERMES_HOME"])
file = home / "config.yaml"

def raw():
    if not file.exists():
        raise ValueError("Set up native Hermes first; its config.yaml is missing.")
    return require_readable_config_before_write(file)

def snapshot():
    cfg = raw()
    model = cfg.get("model") or {}
    if isinstance(model, str): model = {"default": model}
    effort = (cfg.get("agent") or {}).get("reasoning_effort", "")
    return {"settings": {"provider": model.get("provider", ""), "model": model.get("default", ""),
        "base_url": model.get("base_url", ""), "reasoning": "none" if effort is False else effort},
        "revision": hashlib.sha256(file.read_bytes()).hexdigest(), "path": str(file)}

def validate(settings):
    if not isinstance(settings, dict): raise ValueError("Brain settings are required.")
    for key in ("provider", "model", "base_url", "reasoning"):
        if not isinstance(settings.get(key), str): raise ValueError("Each brain field must be text.")
    if not settings["provider"].strip() or not settings["model"].strip():
        raise ValueError("Choose a provider and model.")
    if settings["base_url"]:
        url = urlsplit(settings["base_url"])
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("Use an HTTP(S) endpoint without embedded credentials.")

def save(data):
    settings=data.get("settings"); validate(settings)
    before=snapshot()
    if data.get("revision") != before["revision"]:
        return {"error":"Brain settings changed on disk. Your draft is retained; reload to compare.", "status":409}
    cfg=raw(); updated=copy.deepcopy(cfg)
    if isinstance(updated.get("model"), str): updated["model"]={"default":updated["model"]}
    model=updated.setdefault("model", {})
    model["provider"]=settings["provider"].strip(); model["default"]=settings["model"].strip()
    if settings["base_url"].strip(): model["base_url"]=settings["base_url"].strip()
    else: model.pop("base_url",None)
    agent=updated.setdefault("agent",{})
    if settings["reasoning"]: agent["reasoning_effort"]=settings["reasoning"]
    else: agent.pop("reasoning_effort",None)
    if updated == cfg: return snapshot()
    backups=home/"brain-history";backups.mkdir(mode=0o700,exist_ok=True)
    backup=backups/(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")+"-"+uuid.uuid4().hex+".yaml")
    backup.write_bytes(file.read_bytes());backup.chmod(0o600)
    # Native writer preserves comments and unrelated settings and replaces atomically.
    if hashlib.sha256(file.read_bytes()).hexdigest()!=before["revision"]:
        return {"error":"Brain settings changed during save. Reload to compare.","status":409}
    atomic_config_write(file,updated)
    result=snapshot();result["backup"]=str(backup);return result

def test_connection(data):
    settings=data.get("settings");validate(settings)
    from hermes_cli.config import load_env
    for key,value in load_env().items(): os.environ.setdefault(key,value)
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime=resolve_runtime_provider(requested=settings["provider"],explicit_base_url=settings["base_url"] or None,target_model=settings["model"])
    base=runtime.get("base_url")
    if not base or not str(base).startswith(("http://","https://")):
        return {"ok":False,"message":"Native provider resolved, but this transport has no HTTP model-list check. No inference was submitted."}
    headers={"Accept":"application/json"};key=runtime.get("api_key")
    if key: headers["Authorization"]="Bearer "+key
    if runtime.get("api_mode")=="anthropic_messages":
        headers.pop("Authorization",None);headers.update({"x-api-key":key or "","anthropic-version":"2023-06-01"})
    request=Request(str(base).rstrip("/")+"/models",headers=headers)
    with urlopen(request,timeout=10) as response: value=json.loads(response.read(2*1024*1024))
    models=[m["id"] for m in value.get("data",[]) if isinstance(m,dict) and isinstance(m.get("id"),str)]
    found=settings["model"] in models
    return {"ok":True,"model_listed":found,"models":models,"message":"Connected. "+("Selected model is listed." if found else "Selected model was not listed; some providers accept unlisted aliases.")+" No inference was submitted."}

try:
    data=json.load(sys.stdin)
    result=save(data) if data.get("action")=="save" else test_connection(data) if data.get("action")=="test" else snapshot()
except Exception as error:
    # Avoid returning credential-bearing URLs or provider exceptions to the browser.
    result={"error":str(error) if isinstance(error,ValueError) else "Native Hermes could not complete this request ("+type(error).__name__+"). Check the profile or provider connection.","status":400}
print(json.dumps(result))
