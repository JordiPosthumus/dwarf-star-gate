"""Small JSON-lines adapter to Hermes' supported Python library API.

All files created by Hermes live in the explicitly supplied private HERMES_HOME.
This conversational profile has only explicitly enrolled tools. It does not alter other profiles.
"""
import contextlib
import json
import os
import re
from pathlib import Path
import sys
from threading import Lock
import time
from genie_operating_policy import chat_operating_instructions

WIRE = sys.stdout
WIRE_LOCK = Lock()

def emit(kind, **fields):
    with WIRE_LOCK:
        WIRE.write(json.dumps({"type": kind, **fields}) + "\n")
        WIRE.flush()

class IdentityError(Exception):
    pass

def main():
    source = Path(sys.argv[1]).resolve()
    home = Path(os.environ["HERMES_HOME"]).resolve()
    if home == source or (source / ".env").exists():
        raise ValueError("A separate clean Hermes home and source checkout are required")
    try:
        if not (home / "SOUL.md").read_text().strip():
            raise IdentityError()
        operating_instructions = (home / "AGENTS.md").read_text()
        if not operating_instructions.strip():
            raise IdentityError()
    except OSError:
        raise IdentityError() from None
    request = json.load(sys.stdin)
    sys.path.insert(0, str(source))
    with contextlib.redirect_stdout(sys.stderr):
        from run_agent import AIAgent
        p = request["provider"]
        review = request.get("profile") == "fleet-review"
        research = None if review else request.get("research")
        expected_tools = set()
        toolsets = []
        if research:
            from genie_research import register_research, TOOLSET
            expected_tools = register_research(research, request["context"], emit)
            toolsets.append(TOOLSET)
        inspection = None if review else request.get("inspection")
        if inspection:
            from genie_inspection import register_inspection, TOOLSET as INSPECTION_TOOLSET
            expected_tools |= register_inspection(inspection, request["context"], emit)
            toolsets.append(INSPECTION_TOOLSET)
        operations = None if review else request.get("operations")
        if operations:
            from genie_operations import register_operations, TOOLSET as OPERATIONS_TOOLSET
            expected_tools |= register_operations(operations, emit)
            toolsets.append(OPERATIONS_TOOLSET)
        hourglass = None if review else request.get("hourglass")
        if hourglass:
            from genie_hourglass import register_hourglass, TOOLSET as HOURGLASS_TOOLSET
            expected_tools |= register_hourglass(hourglass, emit)
            toolsets.append(HOURGLASS_TOOLSET)
        queue = None if review else request.get('queue')
        if queue:
            from genie_queue import register_queue, TOOLSET as QUEUE_TOOLSET
            expected_tools |= register_queue(queue, emit)
            toolsets.append(QUEUE_TOOLSET)
        recovery = None if review else request.get('recovery')
        if recovery:
            from genie_recovery import register_recovery, TOOLSET as RECOVERY_TOOLSET
            expected_tools |= register_recovery(recovery, emit)
            toolsets.append(RECOVERY_TOOLSET)
        spark_setup = None if review else request.get('spark_setup')
        if spark_setup:
            from genie_spark_setup import register_spark_setup, TOOLSET as SETUP_TOOLSET
            expected_tools |= register_spark_setup(spark_setup, emit)
            toolsets.append(SETUP_TOOLSET)
        media = None if review else request.get('media')
        if media:
            from genie_media import register_media, TOOLSET as MEDIA_TOOLSET
            expected_tools |= register_media(media, emit)
            toolsets.append(MEDIA_TOOLSET)
        power = None if review else request.get('power')
        if power:
            from genie_power import register_power, TOOLSET as POWER_TOOLSET
            expected_tools |= register_power(power, emit)
            toolsets.append(POWER_TOOLSET)
        admission = None if review else request.get('admission')
        if admission:
            from genie_admission import register_admission, TOOLSET as ADMISSION_TOOLSET
            expected_tools |= register_admission(admission, emit)
            toolsets.append(ADMISSION_TOOLSET)
        # Only fixed phases and counts leave this callback. Never relay reasoning text.
        progress = {"step": 0, "reasoning_chars": 0}
        last_emit = [0.0]
        def report(phase, force=False):
            now = time.monotonic()
            if not review and (force or now - last_emit[0] >= 1):
                last_emit[0] = now
                emit("progress", event={"phase": phase, **progress})
        def step(number, _previous_tools):
            progress["step"] = number
            report("model_wait", True)
        def reasoning(delta):
            if isinstance(delta, str) and delta:
                progress["reasoning_chars"] += len(delta)
                report("reasoning")
        report("starting", True)
        headers={"x-dsg-observer": "gate-genie"}
        call_id=request.get("call_id")
        if not review and isinstance(call_id,str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}",call_id):
            headers["x-dsg-call-id"]=call_id
        agent = AIAgent(
            base_url=p["url"], api_key=p["api_key"] or "local-provider",
            provider="custom", api_mode="chat_completions", model=p["model"],
            enabled_toolsets=toolsets, quiet_mode=True, save_trajectories=False,
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            load_soul_identity=True, session_id=request["session_id"],
            max_tokens=p["max_tokens"], reasoning_config={"effort": p["reasoning_effort"]} if p["reasoning_effort"] is not None else {},
            step_callback=None if review else step, reasoning_callback=None if review else reasoning,
            request_overrides={"extra_headers": headers},
        )
        actual_tools = {t.get("function", t).get("name") for t in agent.tools}
        if inspection or operations or hourglass or queue or recovery or media or spark_setup or power or admission:
            # Hermes may expose plugin tools through its native discovery bridge.
            # Validate the underlying catalog as well as the visible bridge surface.
            from model_tools import get_tool_definitions
            catalog = get_tool_definitions(enabled_toolsets=toolsets, quiet_mode=True, skip_tool_search_assembly=True)
            catalog_names = {t.get("function", t).get("name") for t in catalog}
            if catalog_names != expected_tools or not actual_tools <= expected_tools | {"tool_search", "tool_describe", "tool_call"}:
                raise RuntimeError("The conversational profile exposed an unexpected tool set")
        elif actual_tools != expected_tools:
            raise RuntimeError("The conversational profile exposed an unexpected tool set")
        if review:
            instructions = operating_instructions + "\nFleet review task: return the requested structured JSON. Action requests are proposals for the existing guarded executor, not actions you performed.\n" + request["instructions"]
        else:
            instructions = chat_operating_instructions(operating_instructions, request["context"], {
                'power': power,
                'inspection': inspection,
                'queue': queue,
                'recovery': recovery,
                'media': media,
                'spark_setup': spark_setup,
                'operations': operations,
                'hourglass': hourglass,
                'admission': admission,
            }, research)
        result = agent.run_conversation(
            request["message"], system_message=instructions,
            conversation_history=request["history"],
            stream_callback=None if review else lambda text: emit("delta", text=text) if isinstance(text, str) else None,
        )
        # Hermes can return a terminal failure instead of raising. Its
        # final_response may then contain a raw provider error, not model prose.
        if result.get("failed") or result.get("interrupted") or result.get("completed") is False:
            detail = str(result.get("error", "")) + str(result.get("final_response", ""))
            emit("error", code="reasoning" if "reasoning_effort" in detail else "incomplete")
            return
        text = result.get("final_response")
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("Hermes did not produce a final answer")
    emit("done", text=text)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Exception text can contain a provider response or a secret-bearing URL;
        # send only a fixed category to the dashboard.
        emit("error", code="identity" if isinstance(exc, IdentityError) else "runtime" if isinstance(exc, ImportError) else "provider")
        sys.exit(1)
