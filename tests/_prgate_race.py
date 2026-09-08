#!/usr/bin/env python3
"""Race assertions for pull-request gate write boundaries."""
from _prgate import (
    _RaceApi, _api, _assert_no_writes, _closed_event, _execute,
    _gate_comment, _issue, _pull, _text_html, _valid_body, _valid_html,
    _write_sequence,
)


STATE_ERROR = (
    'pr gate failed: pull request state changed during analysis\n')
CLOSER_ERROR = (
    'pr gate failed: pull request closer changed during analysis\n')
MERGED_ERROR = (
    'pr gate failed: pull request was merged during analysis\n')


def _assert_two_run_replay():
    api = _api(
        issues={},
        rendered=_valid_html(references=_text_html('none')))
    code, writes, output, error = _execute(api, _valid_body('none'))
    assert (code, output, error) == (0, 'closed\n', '')
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    assert api.pull['state'] == 'closed'

    api.issues = {'101': _issue('alice')}
    api.rendered = _valid_html()
    code, writes, output, error = _execute(api, _valid_body())
    assert (code, output, error) == (0, 'reopened\n', '')
    assert _write_sequence(writes[2:]) == [
        ('PATCH', 'repos/owner/repo/issues/comments/100'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    assert api.pull['state'] == 'open'
    assert len(api.comments) == 1
    assert '<!-- pr-gate: closed -->' not in (
        api.comments[0]['body'].splitlines())


def _assert_state_races_abort():
    api = _RaceApi(
        transition='reopened', pull=_pull('closed'),
        issues={'101': _issue('alice')},
        comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()])
    code, writes, output, error = _execute(api, _valid_body())
    assert (code, output, error) == (1, '', STATE_ERROR)
    _assert_no_writes(writes)


def _assert_closer_race_aborts():
    api = _RaceApi(
        transition='closed', pull=_pull('closed'),
        issues={'101': _issue('alice')},
        comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()])
    code, writes, output, error = _execute(api, _valid_body())
    assert (code, output, error) == (1, '', CLOSER_ERROR)
    _assert_no_writes(writes)


def _assert_closed_inadmissible_reclose_aborts():
    api = _RaceApi(
        transition='closed', trigger='pull-read', number=2,
        pull=_pull('closed'), issues={},
        comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()],
        rendered=_valid_html(references=_text_html('none')))
    code, writes, output, error = _execute(api, _valid_body('none'))
    assert (code, output, error) == (1, '', CLOSER_ERROR)
    _assert_no_writes(writes)


def _assert_closed_admissible_reclose_aborts_state():
    api = _RaceApi(
        transition='reclosed', trigger='after-write', number=1,
        pull=_pull('closed'), issues={'101': _issue('alice')},
        comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()])
    code, writes, output, error = _execute(api, _valid_body())
    assert (code, output, error) == (1, '', CLOSER_ERROR)
    assert _write_sequence(writes) == [
        ('PATCH', 'repos/owner/repo/issues/comments/7')]
    assert api.pull['state'] == 'closed'
    assert api.timeline[-1]['actor']['login'] == 'maintainer'


def _assert_open_resolved_human_close_aborts_comment():
    api = _RaceApi(
        transition='closed', trigger='pull-read', number=2,
        pull=_pull(), issues={'101': _issue('alice')},
        comments=[_gate_comment()])
    code, writes, output, error = _execute(api, _valid_body())
    assert (code, output, error) == (1, '', STATE_ERROR)
    _assert_no_writes(writes)


def _assert_open_closable_human_close_aborts_state():
    api = _RaceApi(
        transition='closed', trigger='after-write', number=1,
        pull=_pull(), issues={},
        rendered=_valid_html(references=_text_html('none')))
    code, writes, output, error = _execute(api, _valid_body('none'))
    assert (code, output, error) == (1, '', STATE_ERROR)
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    assert api.pull['state'] == 'closed'
    assert api.timeline[-1]['actor']['login'] == 'maintainer'


def _assert_open_closable_merge_aborts_comment():
    api = _RaceApi(
        transition='merged', trigger='pull-read', number=2,
        pull=_pull(), issues={},
        rendered=_valid_html(references=_text_html('none')))
    code, writes, output, error = _execute(api, _valid_body('none'))
    assert (code, output, error) == (1, '', MERGED_ERROR)
    _assert_no_writes(writes)
