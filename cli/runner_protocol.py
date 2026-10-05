"""The runner's UTF-8 JSONL output, without research dependencies."""

import json
from datetime import datetime


def normalize_utf8_text(value: str) -> str:
    """Return text that can be encoded as strict UTF-8.

    Preserve valid surrogate pairs and replace isolated surrogate code points,
    matching provider response normalization and the existing runner protocol.
    """
    if not any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        return value

    normalized = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF and index + 1 < len(value):
            low = ord(value[index + 1])
            if 0xDC00 <= low <= 0xDFFF:
                normalized.append(chr(0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00)))
                index += 2
                continue
        if 0xD800 <= codepoint <= 0xDFFF:
            normalized.append("\ufffd")
        else:
            normalized.append(value[index])
        index += 1

    return "".join(normalized)


def emit(event: dict) -> None:
    event.setdefault("timestamp", datetime.now().strftime("%H:%M:%S"))
    serialized = json.dumps(event, ensure_ascii=False, default=str)
    print(normalize_utf8_text(serialized), flush=True)
