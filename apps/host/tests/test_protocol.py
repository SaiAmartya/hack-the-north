from phantom_host.protocol import PACKET_PREFIX, parse_radio_line


def test_finds_a_packet_after_the_slug_tag_and_mac() -> None:
    event = parse_radio_line(
        "[phantom_gateway] AA:BB:CC:DD:EE:FF PA1|P1|CAST|F|17\r\n", 10
    )
    assert event is not None
    assert event.sender == "P1"
    assert event.kind == "CAST"
    assert event.value == "F"
    assert event.sequence == 17
    assert event.received_at_ms == 10
    assert event.mac == "AA:BB:CC:DD:EE:FF"


def test_parses_a_payload_only_line() -> None:
    event = parse_radio_line("[phantom_gateway] PA1|P1|CAST|F|17", 10)
    assert event is not None
    assert event.value == "F"
    assert event.mac is None


def test_parses_a_bare_packet_with_no_prefix_at_all() -> None:
    event = parse_radio_line("PA1|P2|CAST|U|255", 4)
    assert event is not None
    assert event.sender == "P2"
    assert event.sequence == 255


def test_rejects_a_sequence_above_the_byte_range() -> None:
    assert parse_radio_line("PA1|P1|CAST|F|999", 10) is None


def test_rejects_too_few_fields() -> None:
    assert parse_radio_line("PA1|P1|CAST|F", 10) is None


def test_rejects_too_many_fields() -> None:
    assert parse_radio_line("PA1|P1|CAST|F|17|extra", 10) is None


def test_rejects_an_unknown_sender() -> None:
    assert parse_radio_line("PA1|XX|CAST|F|1", 10) is None


def test_rejects_an_unknown_kind() -> None:
    assert parse_radio_line("PA1|P1|NOPE|F|1", 10) is None


def test_rejects_a_non_numeric_sequence() -> None:
    assert parse_radio_line("PA1|P1|CAST|F|abc", 10) is None


def test_rejects_a_negative_sequence() -> None:
    assert parse_radio_line("PA1|P1|CAST|F|-1", 10) is None


def test_rejects_an_empty_value() -> None:
    assert parse_radio_line("PA1|P1|CAST||1", 10) is None


def test_rejects_a_line_with_no_packet() -> None:
    assert parse_radio_line("no packet here", 10) is None
    assert parse_radio_line("", 10) is None
    assert parse_radio_line("[boot] app_reg: launched", 10) is None


def test_rejects_a_truncated_prefix() -> None:
    """A half-received line must not be coerced into a packet."""
    assert parse_radio_line("PA", 10) is None
    assert parse_radio_line("PA1|", 10) is None


def test_accepts_judge_event_packets() -> None:
    event = parse_radio_line("[phantom_gateway] PA1|J|EVT|MET|7", 1)
    assert event is not None
    assert event.sender == "J"
    assert event.kind == "EVT"
    assert event.value == "MET"


def test_accepts_ready_packets() -> None:
    event = parse_radio_line("PA1|P2|READY|1|0", 1)
    assert event is not None
    assert event.kind == "READY"


def test_ignores_junk_before_the_prefix_even_if_it_contains_pipes() -> None:
    event = parse_radio_line("garbage|junk|noise PA1|P1|CAST|A|9", 2)
    assert event is not None
    assert event.value == "A"
    assert event.sequence == 9


def test_strips_surrounding_whitespace_from_fields() -> None:
    event = parse_radio_line("PA1|P1|CAST|F|17 \r\n", 3)
    assert event is not None
    assert event.sequence == 17


def test_prefix_constant_matches_the_documented_wire_format() -> None:
    assert PACKET_PREFIX == "PA1|"
