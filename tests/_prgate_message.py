#!/usr/bin/env python3
"""The gate comment's fixed strings and the assertions over one it posts."""
import re


BOT = 'github-actions[bot]'
MARKER = '<!-- pr-gate -->'
CLOSED_MARKER = '<!-- pr-gate: closed -->'
OPEN_FIRST = (
    '@alice — this pull request needs changes before it can be reviewed.')
CLOSED_FIRST = (
    '@alice — closing this automatically; it is recoverable, read on.')
RESOLVED_FIRST = (
    '@alice — every condition now passes; nothing further is needed '
    'from you.')
REOPEN_FIRST = (
    '@alice — the body now names a claimed issue and matches the pull '
    'request')
REASONS_END = (
    'Fix every item above, including these two repository requirements:')


def _comment_body(write):
    return write[2]['body']


def _gate_reasons(body):
    """The reasons a gate comment lists, or None when it lists none.

    Bounding the block by the marker paragraph and the fixed instructions
    keeps the numbered list out of it however it is spelled, and a comment
    carrying those instructions without a well-formed block fails here
    rather than reading as no reasons at all.
    """
    lines = body.splitlines()
    if REASONS_END not in lines:
        return None
    end = lines.index(REASONS_END)
    markers = [index for index, line in enumerate(lines)
               if line in (MARKER, CLOSED_MARKER)]
    assert markers, body
    start = markers[-1] + 1
    assert lines[start] == '' and lines[end - 1] == '', body
    block = lines[start + 1:end - 1]
    assert block and all(line.startswith('- ') for line in block), body
    return [line[2:] for line in block]


def _assert_gate_message(write, first, reasons=(), closed=False):
    body = _comment_body(write)
    lines = body.splitlines()
    assert lines[0] == first, body
    assert MARKER in lines, body
    assert (CLOSED_MARKER in lines) is closed, body
    found = _gate_reasons(body)
    # GitHub renders '-', '*' and '+' as the same list marker, so a
    # bullet the reasons do not name is caught however it is spelled.
    bullets = [line[2:] for line in lines
               if re.match(r'[ \t]*[-*+][ \t]', line)]
    if reasons:
        assert found is not None, (reasons, body)
        assert found == list(reasons), (found, reasons, body)
    else:
        assert found is None, (found, body)
    assert bullets == list(reasons), (bullets, reasons, body)
    return body


def _assert_no_writes(writes):
    assert writes == [], writes
