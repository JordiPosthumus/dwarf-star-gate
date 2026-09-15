# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright contributors to the vLLM project
"""Incremental reasoning EOS masking for Model Runner V2."""

import numpy as np
import torch

from vllm.config.reasoning import ReasoningConfig
from vllm.sampling_params import SamplingParams
from vllm.triton_utils import tl, triton
from vllm.utils.torch_utils import async_tensor_h2d
from vllm.v1.worker.gpu.buffer_utils import UvaBackedTensor
from vllm.v1.worker.gpu.sample.thinking_budget import _load_effective_token
from vllm.v1.worker.gpu.states import RequestState


class ReasoningEOSState:
    def __init__(self, req_states: RequestState, config: ReasoningConfig | None):
        self.req_states = req_states
        self.enabled = bool(getattr(config, "suppress_eos_in_reasoning", False))
        self.use_guard = np.zeros(req_states.max_num_reqs, dtype=bool)
        if not self.enabled:
            return
        assert config is not None
        self.start_ids = torch.tensor(
            config.reasoning_start_token_ids,
            dtype=torch.int32,
            device=req_states.device,
        )
        self.end_ids = torch.tensor(
            config.natural_reasoning_end_token_ids,
            dtype=torch.int32,
            device=req_states.device,
        )
        self.eos_ids = torch.tensor(
            config._eos_token_ids, dtype=torch.int32, device=req_states.device
        )
        self.tool_start = config._tool_start_token_id
        self.tool_end = config._tool_end_token_id
        prefix = "<function="
        # 0: content, 1: reasoning, 2 + n: a tool opener followed by n prefix chars.
        transitions = np.ones((len(prefix), req_states.vocab_size), dtype=np.int8)
        for n in range(len(prefix)):
            for token_id, text in config._tool_preamble_token_texts.items():
                candidate = (prefix[:n] + text).lstrip()
                if candidate.startswith(prefix):
                    transitions[n, token_id] = 0
                elif prefix.startswith(candidate):
                    transitions[n, token_id] = 2 + len(candidate)
        self.transitions = torch.tensor(transitions, device=req_states.device)
        self.guard_enabled = UvaBackedTensor(req_states.max_num_reqs, dtype=torch.int32)
        self.guard_enabled.np.fill(0)
        self.guard_enabled.copy_to_uva()
        self.phase = torch.zeros(
            req_states.max_num_reqs, dtype=torch.int32, device=req_states.device
        )
        self.scan_pos = torch.zeros_like(self.phase)
        self._reset_reqs: list[int] = []

    def add_request(self, req_idx: int, params: SamplingParams) -> None:
        if not self.enabled:
            return
        self.use_guard[req_idx] = not params.ignore_eos
        self.guard_enabled.np[req_idx] = int(not params.ignore_eos)
        self._reset_reqs.append(req_idx)

    def apply_staged_writes(self) -> None:
        if not self.enabled or not self._reset_reqs:
            return
        ids = async_tensor_h2d(
            self._reset_reqs, dtype=torch.int64, device=self.req_states.device
        )
        self.phase.index_fill_(0, ids, 0)
        self.scan_pos.index_fill_(0, ids, 0)
        self.guard_enabled.copy_to_uva()
        self._reset_reqs.clear()

    def apply(
        self,
        logits,
        expanded_idx_mapping,
        idx_mapping,
        idx_mapping_np,
        input_ids,
        expanded_local_pos,
    ) -> None:
        if not self.enabled or not np.any(self.use_guard[idx_mapping_np]):
            return
        shared = (
            self.guard_enabled.gpu,
            self.req_states.all_token_ids.gpu,
            self.req_states.all_token_ids.gpu.stride(0),
            self.req_states.total_len.gpu,
            self.phase,
            self.scan_pos,
            self.start_ids,
            self.end_ids,
            self.transitions,
        )
        options = dict(
            START_LEN=self.start_ids.numel(),
            END_LEN=self.end_ids.numel(),
            VOCAB=self.req_states.vocab_size,
            TOOL_START=-1 if self.tool_start is None else self.tool_start,
            TOOL_END=-1 if self.tool_end is None else self.tool_end,
        )
        _update_committed_phase[(idx_mapping.numel(),)](idx_mapping, *shared, **options)
        _mask_reasoning_eos[(logits.shape[0],)](
            logits,
            logits.stride(0),
            expanded_idx_mapping,
            input_ids,
            expanded_local_pos,
            self.eos_ids,
            *shared,
            EOS_COUNT=self.eos_ids.numel(),
            **options,
        )


@triton.jit
def _advance_phase(
    phase,
    pos,
    all_ids,
    stride,
    input_ids,
    first,
    req,
    total,
    start_ids,
    end_ids,
    transitions,
    START_LEN: tl.constexpr,
    END_LEN: tl.constexpr,
    VOCAB: tl.constexpr,
    TOOL_START: tl.constexpr,
    TOOL_END: tl.constexpr,
):
    start_match = pos + 1 >= START_LEN
    for j in tl.static_range(0, START_LEN):
        if pos + 1 >= START_LEN:
            actual = _load_effective_token(
                all_ids, stride, input_ids, first, req, total, pos + 1 - START_LEN + j
            )
            start_match = start_match & (actual == tl.load(start_ids + j))
    end_match = pos + 1 >= END_LEN
    for j in tl.static_range(0, END_LEN):
        if pos + 1 >= END_LEN:
            actual = _load_effective_token(
                all_ids, stride, input_ids, first, req, total, pos + 1 - END_LEN + j
            )
            end_match = end_match & (actual == tl.load(end_ids + j))
    token = _load_effective_token(all_ids, stride, input_ids, first, req, total, pos)
    if start_match:
        phase = 1
    elif end_match:
        phase = 0
    elif phase > 0 and token == TOOL_START:
        phase = 2
    elif phase >= 2:
        if token == TOOL_END:
            phase = 0
        else:
            phase = tl.load(transitions + (phase - 2) * VOCAB + token).to(tl.int32)
    return phase


@triton.jit
def _update_committed_phase(
    req_ids,
    enabled,
    all_ids,
    stride,
    total_lens,
    phases,
    scan_positions,
    start_ids,
    end_ids,
    transitions,
    START_LEN: tl.constexpr,
    END_LEN: tl.constexpr,
    VOCAB: tl.constexpr,
    TOOL_START: tl.constexpr,
    TOOL_END: tl.constexpr,
    BLOCK: tl.constexpr = 1024,
):
    req = tl.load(req_ids + tl.program_id(0))
    if tl.load(enabled + req) == 0:
        return
    total = tl.load(total_lens + req)
    scan = tl.load(scan_positions + req)
    phase = tl.load(phases + req)
    if scan == 0 or scan > total:
        # Most prompts end in a reasoning marker. Find the latest marker in
        # parallel blocks, then inspect only the following tool preamble/text.
        last_start = -1
        last_end = -1
        hi = total
        while hi > 0 and last_start < 0 and last_end < 0:
            lo = tl.maximum(0, hi - BLOCK)
            offs = lo + tl.arange(0, BLOCK)
            sm = (offs < hi) & (offs + START_LEN <= total)
            em = (offs < hi) & (offs + END_LEN <= total)
            for j in tl.static_range(0, START_LEN):
                token = tl.load(
                    all_ids + req * stride + offs + j, mask=offs + j < total, other=-1
                )
                sm = sm & (token == tl.load(start_ids + j))
            for j in tl.static_range(0, END_LEN):
                token = tl.load(
                    all_ids + req * stride + offs + j, mask=offs + j < total, other=-1
                )
                em = em & (token == tl.load(end_ids + j))
            last_start = tl.max(tl.where(sm, offs, -1), axis=0)
            last_end = tl.max(tl.where(em, offs, -1), axis=0)
            hi = lo
        phase = tl.where(last_start > last_end, 1, 0)
        scan = tl.where(
            last_start > last_end,
            last_start + START_LEN,
            tl.where(last_end >= 0, last_end + END_LEN, total),
        )
    for pos in tl.range(scan, total):
        phase = _advance_phase(
            phase,
            pos,
            all_ids,
            stride,
            all_ids,
            0,
            req,
            total,
            start_ids,
            end_ids,
            transitions,
            START_LEN,
            END_LEN,
            VOCAB,
            TOOL_START,
            TOOL_END,
        )
    tl.store(phases + req, phase)
    tl.store(scan_positions + req, total)


@triton.jit
def _mask_reasoning_eos(
    logits,
    logits_stride,
    expanded_req_ids,
    input_ids,
    local_positions,
    eos_ids,
    enabled,
    all_ids,
    stride,
    total_lens,
    phases,
    scan_positions,
    start_ids,
    end_ids,
    transitions,
    EOS_COUNT: tl.constexpr,
    START_LEN: tl.constexpr,
    END_LEN: tl.constexpr,
    VOCAB: tl.constexpr,
    TOOL_START: tl.constexpr,
    TOOL_END: tl.constexpr,
):
    row = tl.program_id(0)
    req = tl.load(expanded_req_ids + row)
    if tl.load(enabled + req) == 0:
        return
    total = tl.load(total_lens + req)
    local_pos = tl.load(local_positions + row)
    phase = tl.load(phases + req)
    first = row - local_pos
    # Draft prefixes affect only this row, never the committed phase cache.
    for pos in tl.range(total, total + local_pos):
        phase = _advance_phase(
            phase,
            pos,
            all_ids,
            stride,
            input_ids,
            first,
            req,
            total,
            start_ids,
            end_ids,
            transitions,
            START_LEN,
            END_LEN,
            VOCAB,
            TOOL_START,
            TOOL_END,
        )
    if phase > 0:
        for i in tl.static_range(0, EOS_COUNT):
            eos = tl.load(eos_ids + i)
            tl.store(logits + row * logits_stride + eos, -float("inf"))
