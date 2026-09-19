"""Parse gateway serial lines into RadioEvents.

The gateway badge emits ``badge.sys.log(mac .. " " .. payload)``, and
``badge.sys.log`` prefixes every line with the app slug. So a real line looks
like::

    [phantom_gateway] AA:BB:CC:DD:EE:FF PA1|P1|CAST|F|17

We therefore search for the packet prefix anywhere in the line rather than
anchoring at the start, and treat anything before it as decoration that may
optionally yield the sender's BLE address.

Parsing never raises. A malformed line is not an error condition worth
propagating during a live match; it is a line we skip.
"""

from __future__ import annotations

import re

from pydantic import ValidationError

from phantom_host.contracts import RadioEvent

PACKET_PREFIX = "PA1|"
PACKET_FIELD_COUNT = 5

_MAC_AT_END = re.compile(r"([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s*$")


def _extract_mac(head: str) -> str | None:
    """Pull a BLE address off the end of the text preceding the packet."""
    match = _MAC_AT_END.search(head)
    return match.group(1) if match else None


def parse_radio_line(line: str, received_at_ms: int) -> RadioEvent | None:
    """Return a RadioEvent, or None for anything we do not fully trust."""
    if not line:
        return None

    index = line.find(PACKET_PREFIX)
    if index < 0:
        return None

    mac = _extract_mac(line[:index])
    fields = [field.strip() for field in line[index:].strip().split("|")]
    if len(fields) != PACKET_FIELD_COUNT:
        return None

    _prefix, sender, kind, value, sequence_text = fields
    if not value or not sequence_text.isdigit():
        # isdigit() also rejects "-1" and "+1", which int() would happily accept.
        return None

    try:
        return RadioEvent(
            sender=sender,  # type: ignore[arg-type]
            kind=kind,  # type: ignore[arg-type]
            value=value,
            sequence=int(sequence_text),
            received_at_ms=received_at_ms,
            mac=mac,
        )
    except ValidationError:
        # Unknown sender/kind, or a sequence outside 0-255.
        return None
