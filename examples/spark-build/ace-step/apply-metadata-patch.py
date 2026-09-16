"""Retain the installed recipe's result provenance; no generation-setting changes."""
from pathlib import Path
import ast

path = Path('/opt/ace-step/acestep/inference.py')
text = path.read_text()
anchor = '        extra_outputs["lm_metadata"] = lm_generated_metadata\n'
if text.count(anchor) != 1:
    raise RuntimeError('Pinned ACE result metadata location differs')
text = text.replace(anchor, anchor + '        extra_outputs["effective_caption"] = dit_input_caption\n'
                    '        extra_outputs["effective_lyrics"] = dit_input_lyrics\n', 1)
ast.parse(text)
path.write_text(text)
