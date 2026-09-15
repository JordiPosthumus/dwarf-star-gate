"""Strict reviewed controls for this Qwen vLLM deployment."""
import math
from vllm.exceptions import VLLMValidationError
from vllm.sampling_params import _MAX_TEMP
from vllm.logger import init_logger

logger = init_logger(__name__)


def _error(name, message):
    raise VLLMValidationError(f"{name}: {message}", parameter=name)


def is_qwen(model):
    return model in (None, "qwen3.8-flash-next")


def validate_qwen_request(data, supported_fields):
    if not isinstance(data, dict) or not is_qwen(data.get("model")):
        return data
    for name in ("enable_thinking", "preserve_thinking"):
        if name in data:
            _error(name, f"use chat_template_kwargs.{name}; top-level placement is unsupported")
    unknown = set(data) - set(supported_fields)
    if unknown:
        _error(sorted(unknown)[0], "unsupported request field for this backend")
    if "max_tokens" in data and "max_completion_tokens" in data:
        _error("max_tokens", "send only one output-limit field: max_tokens or max_completion_tokens")
    nested = data.get("chat_template_kwargs")
    if nested is None:
        nested = {}
    if not isinstance(nested, dict):
        _error("chat_template_kwargs", "must be an object")
    for name in nested:
        if name not in {"enable_thinking", "preserve_thinking", "reasoning_effort"}:
            _error(f"chat_template_kwargs.{name}", "unsupported Qwen template control")
    for name in ("enable_thinking", "preserve_thinking"):
        if name in nested and not isinstance(nested[name], bool):
            _error(f"chat_template_kwargs.{name}", "must be true or false")
    if data.get("reasoning_effort") is not None and "reasoning_effort" in nested:
        _error("reasoning_effort", "send effort in only one location, top-level or chat_template_kwargs")
    effort = nested.get("reasoning_effort", data.get("reasoning_effort"))
    if "reasoning_effort" in nested or data.get("reasoning_effort") is not None:
        # Preserve vLLM's existing explicit off-mode selector. Its request
        # builder sets enable_thinking=False; it is not an effort alias.
        native_off = effort == "none" and "reasoning_effort" not in nested
        if native_off:
            if nested.get("enable_thinking") is True:
                _error("reasoning_effort", "none selects thinking off and conflicts with enable_thinking=true")
        elif not isinstance(effort, str) or effort not in ("low", "medium", "xhigh"):
            _error("reasoning_effort", "supported effort values are low, medium, xhigh; use enable_thinking=false for off mode")
    integers = {"top_k", "max_tokens", "max_completion_tokens", "seed"}
    for name in ("temperature", "top_p", "top_k", "min_p", "repetition_penalty",
                 "presence_penalty", "frequency_penalty", "max_tokens",
                 "max_completion_tokens", "seed"):
        value = data.get(name)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            _error(name, "must be a number")
        if name in integers and not isinstance(value, int):
            _error(name, "must be an integer")
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            _error(name, "must be finite")
    temperature = data.get("temperature")
    if temperature is not None and 0 < temperature < _MAX_TEMP:
        _error("temperature", f"positive values below {_MAX_TEMP} are not supported exactly by this sampler; use 0 for greedy or at least {_MAX_TEMP}")
    return data


def enforce_qwen_output_request(request, available):
    if not is_qwen(request.model):
        return
    requested = request.max_completion_tokens if request.max_completion_tokens is not None else request.max_tokens
    if requested is not None and requested <= 0:
        _error("max_tokens", "must be greater than zero")
    if available < 1:
        _error("max_tokens", "prompt/context limits leave no room for output")
    if requested is not None and requested > available:
        # The shared resolver already counted the complete rendered input and
        # applied the requested, context, server and platform upper bounds.
        # SamplingParams and BeamSearchParams receive that resolved value.
        logger.info(
            "Qwen output upper bound resolved: requested=%d, effective=%d",
            requested, available,
        )
