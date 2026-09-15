# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright contributors to the vLLM project

from dataclasses import field

from vllm.config.model import ModelConfig
from vllm.config.utils import config
from vllm.reasoning import ReasoningParserManager
from vllm.tokenizers import cached_tokenizer_from_config


@config
class ReasoningConfig:
    """Configuration for reasoning models.

    Set `reasoning_start_str` and `reasoning_end_str` to the strings used to
    enter and forcibly terminate reasoning. The end string may include a
    transition phrase before the parser's natural reasoning end marker. Token
    IDs are derived automatically by `initialize_token_ids`.
    """

    reasoning_parser: str = ""
    """The name of the ReasoningParser to use for this model."""
    reasoning_start_str: str = ""
    """String that indicates the start of reasoning."""
    reasoning_end_str: str = ""
    """String forced when the thinking budget is exhausted."""
    suppress_eos_in_reasoning: bool = False
    """Suppress model EOS tokens while reasoning is open, without forcing an end.

    Opt-in recovery for premature EOS. The request's output limit still applies.
    """

    _eos_token_ids: list[int] = field(default_factory=list, init=False, repr=False)
    """Model EOS IDs suppressed while the guard is active."""
    _tool_start_token_id: int | None = field(default=None, init=False, repr=False)
    """Qwen tool opener whose function header must be validated."""
    _tool_end_token_id: int | None = field(default=None, init=False, repr=False)
    """Qwen tool closer; also closes an empty wrapper."""
    _tool_preamble_token_texts: dict[int, str] = field(
        default_factory=dict, init=False, repr=False
    )
    """Token text needed to recognize a Qwen function header after a tool opener."""

    _reasoning_start_token_ids: list[int] | None = field(
        default=None, init=False, repr=False
    )
    """Private backing field for `reasoning_start_token_ids`. Set by
    `initialize_token_ids`. Not intended to be configured directly."""
    _reasoning_end_token_ids: list[int] | None = field(
        default=None, init=False, repr=False
    )
    """Private backing field for forced reasoning end token IDs."""
    _natural_reasoning_end_token_ids: list[int] | None = field(
        default=None, init=False, repr=False
    )
    """Token IDs that naturally terminate reasoning, as defined by the parser."""

    _enabled: bool = field(default=False, init=False, repr=False)
    """Private field indicating whether reasoning token IDs have been initialized.
    Set to True by `initialize_token_ids` once token IDs are initialized."""

    @property
    def enabled(self) -> bool:
        """Returns True if reasoning is enabled (i.e. if token IDs have been
        initialized), False otherwise."""
        return self._enabled

    @property
    def reasoning_start_token_ids(self) -> list[int] | None:
        """Token IDs derived from `reasoning_start_str`. Set automatically by
        `initialize_token_ids`. Not intended to be configured directly."""
        return self._reasoning_start_token_ids

    @property
    def reasoning_end_token_ids(self) -> list[int] | None:
        """Token IDs forced when the thinking budget is exhausted."""
        return self._reasoning_end_token_ids

    @property
    def natural_reasoning_end_token_ids(self) -> list[int] | None:
        """Token IDs that indicate the model naturally ended reasoning."""
        return self._natural_reasoning_end_token_ids

    def initialize_token_ids(self, model_config: ModelConfig) -> None:
        """Initialize reasoning token IDs from strings using the tokenizer."""
        if (
            self._reasoning_start_token_ids is not None
            and self._reasoning_end_token_ids is not None
            and self._natural_reasoning_end_token_ids is not None
        ):
            self._enabled = True
            return  # Already initialized

        tokenizer = cached_tokenizer_from_config(model_config=model_config)
        if self.suppress_eos_in_reasoning:
            eos_ids = model_config.try_get_generation_config().get("eos_token_id", [])
            if isinstance(eos_ids, int):
                eos_ids = [eos_ids]
            self._eos_token_ids = list(eos_ids or [])
            if tokenizer.eos_token_id is not None:
                self._eos_token_ids.append(tokenizer.eos_token_id)
            self._eos_token_ids = sorted(set(self._eos_token_ids))
            if self.reasoning_parser == "qwen3":
                vocab = tokenizer.get_vocab()
                self._tool_start_token_id = vocab.get("<tool_call>")
                self._tool_end_token_id = vocab.get("</tool_call>")
                if self._tool_start_token_id is not None:
                    prefix = "<function="
                    suffixes = tuple(prefix[i:] for i in range(len(prefix)))
                    for token_id in vocab.values():
                        text = tokenizer.decode([token_id], skip_special_tokens=False)
                        part = text.lstrip()
                        if not part or part in prefix or part.startswith(suffixes):
                            self._tool_preamble_token_texts[token_id] = text
        reasoning_start_str = self.reasoning_start_str
        reasoning_end_str = self.reasoning_end_str
        natural_reasoning_end_str = ""
        if self.reasoning_parser:
            parser_cls = ReasoningParserManager.get_reasoning_parser(
                self.reasoning_parser
            )
            reasoning_parser = parser_cls(tokenizer)
            start_token = reasoning_parser.reasoning_start_str
            if start_token and not reasoning_start_str:
                reasoning_start_str = start_token

            end_token = reasoning_parser.reasoning_end_str
            if end_token and not reasoning_end_str:
                reasoning_end_str = end_token
            natural_reasoning_end_str = end_token or ""

        if not natural_reasoning_end_str:
            natural_reasoning_end_str = reasoning_end_str

        if not reasoning_start_str or not reasoning_end_str:
            if self.suppress_eos_in_reasoning:
                raise ValueError(
                    "suppress_eos_in_reasoning requires reasoning start/end markers"
                )
            # If we don't have valid strings to tokenize,
            # we can't initialize the token IDs.
            return
        self._reasoning_start_token_ids = tokenizer.encode(
            reasoning_start_str, add_special_tokens=False
        )
        self._reasoning_end_token_ids = tokenizer.encode(
            reasoning_end_str, add_special_tokens=False
        )
        self._natural_reasoning_end_token_ids = tokenizer.encode(
            natural_reasoning_end_str, add_special_tokens=False
        )

        if (
            not self._reasoning_start_token_ids
            or not self._reasoning_end_token_ids
            or not self._natural_reasoning_end_token_ids
        ):
            raise ValueError(
                f"ReasoningConfig: failed to tokenize reasoning strings: "
                f"reasoning_start_str='{self.reasoning_start_str}', "
                f"reasoning_end_str='{self.reasoning_end_str}'. "
                "Ensure the strings are valid tokens in the model's vocabulary."
            )
        self._enabled = True
