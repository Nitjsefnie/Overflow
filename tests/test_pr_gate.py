#!/usr/bin/env python3
"""Pull-request gate state transitions and write ordering."""
import itertools
import os
import re
import subprocess
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util  # noqa: E402
from _prgate import (  # noqa: E402
    BOT, CLOSED_FIRST, MARKER, OPEN_FIRST, REOPEN_FIRST,
    RESOLVED_FIRST, TEMPLATE,
    _api, _assert_gate_message, _assert_no_writes, _assert_script_error,
    _assert_script_runs_through_gh_on_path,
    _capture, _closed_event, _comment_page_fields, _execute,
    _execute_without_runtime_escape, _gate_comment, _gate_module,
    _html_body, _inline_marker_comment, _issue, _markdown_code_spans,
    _PaginationApi,
    _recorded_writes, _run_script, _runtime_error, _script_fixtures,
    _text_html, _valid_body, _valid_html, _write_gh_stub, _write_sequence,
)
from _prfootnotes import (  # noqa: E402
    NESTED_HEADING_HTML, NESTED_HEADING_NOTE)
from _prgate_race import (  # noqa: E402
    _assert_closed_admissible_reclose_aborts_state,
    _assert_closed_inadmissible_reclose_aborts,
    _assert_closer_race_aborts,
    _assert_open_closable_human_close_aborts_state,
    _assert_open_closable_merge_aborts_comment,
    _assert_open_resolved_human_close_aborts_comment,
    _assert_state_races_abort, _assert_two_run_replay,
)
from _prgate import ROOT  # noqa: E402


# Each body paired with the rendering GitHub's /markdown returned for it
# in GFM mode with this repository as the context: the empty string for
# some, newline padding for others.
RENDERS_TO_NOTHING = (
    (None, ''),
    ('', ''),
    ('   \n\t\n', ''),
    ('<!-- draft -->', ''),
    ('<!-- a -->\n\n<!-- b -->', '\n'),
    ('<!-- a -->\n\n<!-- b -->\n\n<!-- c -->', '\n\n'),
)
MISSING_SECTIONS = [
    f'Required section "{name}" is missing.' for name in (
        'Summary', 'Related Issues and Pull Requests', 'Changes',
        'Testing')]


def test_admissible_open_without_prior_comment_does_not_write(tmp):
    del tmp
    code, writes, output, _error = _execute(_api(), _valid_body())
    assert code == 0
    _assert_no_writes(writes)
    assert '101' in output, output


def test_admissible_open_resolves_a_prior_gate_comment(tmp):
    del tmp
    api = _api(comments=[_gate_comment()])
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('PATCH', 'repos/owner/repo/issues/comments/7')]
    _assert_gate_message(writes[0], RESOLVED_FIRST)


def test_inline_marker_mention_is_not_a_closed_gate_comment(tmp):
    del tmp
    api = _api(
        state='closed', comments=[_inline_marker_comment()],
        timeline=[_closed_event()])
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    _assert_no_writes(writes)
    assert api.pull['state'] == 'closed'


def test_inline_marker_mention_does_not_replace_a_new_comment(tmp):
    del tmp
    api = _api(
        comments=[_inline_marker_comment()],
        issues={'101': _issue('bob')})
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]


def test_contributor_marker_comment_is_not_selected(tmp):
    del tmp
    comment = {
        'id': 55,
        'user': {'login': 'alice'},
        'body': f'contributor note\n{MARKER}',
    }
    code, writes, _output, _error = _execute(
        _api(comments=[comment]), _valid_body())
    assert code == 0
    _assert_no_writes(writes)


def test_earliest_bot_marker_comment_is_selected(tmp):
    del tmp
    later = {
        'id': 8,
        'user': {'login': BOT},
        'body': f'later gate message\n{MARKER}',
    }
    code, writes, _output, _error = _execute(
        _api(comments=[_gate_comment(), later]), _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('PATCH', 'repos/owner/repo/issues/comments/7')]


def test_bodies_github_renders_away_are_reported_and_closed(tmp):
    del tmp
    for body, rendered in RENDERS_TO_NOTHING:
        code, writes, _output, _error = _execute(
            _api(issues={}, rendered=rendered), body)
        assert code == 0, body
        assert _write_sequence(writes) == [
            ('POST', 'repos/owner/repo/issues/99/comments'),
            ('PATCH', 'repos/owner/repo/pulls/99')], body
        _assert_gate_message(
            writes[0], CLOSED_FIRST,
            [*MISSING_SECTIONS, 'No checked issue is assigned to you.'],
            closed=True)


def test_a_body_of_only_template_comments_is_reported_and_closed(tmp):
    """Instruction comments render as padding after all headings are removed."""
    del tmp
    body = '\n\n'.join(re.findall(r'<!--.*?-->', TEMPLATE, re.DOTALL))
    code, writes, _output, _error = _execute(
        _api(issues={}, rendered='\n' * 9), body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        [*MISSING_SECTIONS, 'Remove the template instruction comments.',
         'No checked issue is assigned to you.'], closed=True)


def test_retained_instruction_comment_closes(tmp):
    del tmp
    instruction = re.search(r'<!--.*?-->', TEMPLATE, re.DOTALL).group(0)
    body = _valid_body().replace(
        '- One change', f'- One change\n{instruction}')
    code, writes, _output, _error = _execute(_api(), body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['Remove the template instruction comments.'], closed=True)


def test_a_bullet_spelled_with_a_star_is_read_as_a_bullet(tmp):
    """The reason set is pinned against a marker class, not one spelling.

    A gate comment growing an item spelled `* ` carries a bullet no
    code path asked for, and GitHub renders it exactly as a `- ` item.
    Collecting bullets by the `- ` spelling alone leaves that mutation
    of the comment green at every call site here.
    """
    del tmp
    instruction = re.search(r'<!--.*?-->', TEMPLATE, re.DOTALL).group(0)
    body = _valid_body().replace(
        '- One change', f'- One change\n{instruction}')
    _code, writes, _output, _error = _execute(_api(), body)
    method, path, payload = writes[0]
    strayed = (
        method, path,
        {**payload, 'body': payload['body'] + '* Stray bullet.\n'})
    try:
        _assert_gate_message(
            strayed, CLOSED_FIRST,
            ['Remove the template instruction comments.'], closed=True)
    except AssertionError:
        pass
    else:
        raise AssertionError('a bullet spelled "* " went unseen')


def test_the_bullet_matcher_decides_indent_marker_and_separator(tmp):
    """Every decision the matcher makes, on its own axis.

    The marker and separator alphabets are finite, so those two axes
    are exhausted. The indent is unbounded repetition, so it runs to
    the width this comment can render: a stray bullet is still a list
    item at the numbered item's content column of three plus
    CommonMark's three-space allowance, so six is the domain and seven
    is the near miss the table carries past it. A bound of seven or
    wider survives here, outside what the comment can render rather
    than merely further out. The separator is the only axis answering
    no, so its rows keep the rest from passing vacuously.
    """
    del tmp
    indents = [''.join(pad) for width in range(8)
               for pad in itertools.product(' \t', repeat=width)]
    failures = []
    for indent, marker, separator in itertools.product(
            indents, '-*+', (' ', '\t', '')):
        stray = f'{indent}{marker}{separator}Stray.'
        write = ('POST', 'url', {
            'body': '\n'.join((OPEN_FIRST, MARKER, stray))})
        try:
            _assert_gate_message(write, OPEN_FIRST)
        except AssertionError:
            seen = True
        else:
            seen = False
        if seen is not bool(separator):
            failures.append((stray, seen))
    assert failures == [], failures


def test_gate_closed_admissible_pull_is_commented_then_reopened(tmp):
    del tmp
    api = _api(
        state='closed', comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()])
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('PATCH', 'repos/owner/repo/issues/comments/7'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(writes[0], REOPEN_FIRST)
    assert writes[1][2] == {'state': 'open'}


def test_gate_closed_inadmissible_pull_updates_comment_and_stays_closed(tmp):
    del tmp
    body = _valid_body('none')
    rendered = _valid_html(references=_text_html('none'))
    api = _api(
        state='closed', issues={}, comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()], rendered=rendered)
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('PATCH', 'repos/owner/repo/issues/comments/7')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['No checked issue is assigned to you.'], closed=True)


def test_human_closed_pull_is_not_written(tmp):
    del tmp
    api = _api(
        state='closed', comments=[_gate_comment(closed=True)],
        timeline=[_closed_event('alice')])
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    _assert_no_writes(writes)


def test_bot_timeline_without_closed_marker_is_not_gate_owned(tmp):
    del tmp
    api = _api(
        state='closed', comments=[_gate_comment()],
        timeline=[_closed_event()])
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    _assert_no_writes(writes)


def test_unreadable_closed_timeline_fails_without_writes(tmp):
    del tmp
    api = _api(
        state='closed', comments=[_gate_comment(closed=True)],
        timeline=[_closed_event()], fail={'timeline'})
    code, writes, _output, error = _execute(api, _valid_body())
    assert code == 1
    _assert_no_writes(writes)
    assert error == (
        'pr gate failed: GitHub returned 500 for '
        'repos/owner/repo/issues/99/timeline\n')


def test_state_changes_during_analysis_abort_writes(tmp):
    del tmp
    _assert_state_races_abort()


def test_latest_closer_change_during_analysis_aborts_reopen(tmp):
    del tmp
    _assert_closer_race_aborts()


def test_closed_inadmissible_human_reclose_aborts_comment_patch(_tmp):
    _assert_closed_inadmissible_reclose_aborts()


def test_closed_admissible_reclose_after_comment_aborts_reopen(_tmp):
    _assert_closed_admissible_reclose_aborts_state()


def test_open_admissible_human_close_aborts_resolved_comment_patch(_tmp):
    _assert_open_resolved_human_close_aborts_comment()


def test_open_closable_human_close_after_comment_landed_aborts_state(_tmp):
    _assert_open_closable_human_close_aborts_state()


def test_open_closable_merge_aborts_before_comment(_tmp):
    _assert_open_closable_merge_aborts_comment()


def test_merged_pull_returns_before_comments_or_render(tmp):
    del tmp
    api = _api(merged=True, fail={'comments', 'markdown'})
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    _assert_no_writes(writes)
    assert api.calls == [
        ('GET', 'repos/owner/repo/pulls/99', None)]


def test_unusable_render_fails_without_writes(tmp):
    del tmp
    cases = (
        (
            _api(fail={'markdown'}),
            'pr gate failed: GitHub returned 500 for markdown\n',
        ),
        (
            _api(rendered='<h2>Summary</h2><p'),
            'pr gate failed: could not analyze rendered body: '
            'rendered HTML is structurally incomplete\n',
        ),
    )
    for api, expected in cases:
        code, writes, _output, error = _execute(api, _valid_body())
        assert code == 1
        _assert_no_writes(writes)
        assert error == expected


def test_failed_comment_write_prevents_state_change(tmp):
    del tmp
    body = _valid_body('none')
    rendered = _valid_html(references=_text_html('none'))
    api = _api(
        issues={}, rendered=rendered,
        fail={'POST repos/owner/repo/issues/99/comments'})
    code, writes, _output, error = _execute(api, body)
    assert code == 1
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    assert api.pull['state'] == 'open'
    assert error == (
        'pr gate failed: GitHub returned 500 for '
        'repos/owner/repo/issues/99/comments\n')


def test_one_edit_self_heals_gate_closed_state(tmp):
    del tmp
    _assert_two_run_replay()


def test_unknown_section_name_cannot_inject_a_live_reference(tmp):
    del tmp
    name = 'x`#1'
    body = _valid_body() + f'\n## {name}\nUnknown.\n'
    rendered = _valid_html() + _html_body((name, _text_html('Unknown.')))
    code, writes, _output, _error = _execute(
        _api(rendered=rendered), body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    comment = _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['Section ``x`#1`` is not defined by the template.'], closed=True)
    spans = _markdown_code_spans(comment)
    for match in re.finditer(r'#1', comment):
        assert any(start <= match.start() < end for start, end in spans), (
            match.start(), spans, comment)


def test_a_nested_heading_comments_and_closes(tmp):
    del tmp
    rendered = NESTED_HEADING_HTML['footnote_section_in_heading']
    code, writes, _output, _error = _execute(
        _api(rendered=rendered), _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['Section "Testing" is empty.', NESTED_HEADING_NOTE,
         'No checked issue is assigned to you.'], closed=True)


def test_a_nested_heading_alone_closes(tmp):
    del tmp
    rendered = NESTED_HEADING_HTML['empty_heading_in_div']
    code, writes, _output, _error = _execute(
        _api(rendered=rendered), _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        [NESTED_HEADING_NOTE, 'No checked issue is assigned to you.'],
        closed=True)




def test_script_runs_through_gh_on_path(tmp):
    _assert_script_runs_through_gh_on_path(tmp)


def test_gh_absent_from_path_is_reported(tmp):
    empty = Path(tmp) / 'empty'
    empty.mkdir()
    gate = _gate_module()
    with mock.patch.dict(os.environ, {'PATH': str(empty)}):
        api = gate.GhApi()
    assert api.gh is None
    assert _runtime_error(
        lambda: api.request('GET', 'repos/owner/repo/pulls/99')) == (
            'gh was not found on PATH')


def test_gh_oserror_is_reported(tmp):
    target = Path(tmp) / 'not-executable'
    target.write_text('not executable', encoding='utf-8')
    target.chmod(0o644)
    api = _gate_module().GhApi()
    api.gh = str(target)
    error = _runtime_error(
        lambda: api.request('GET', 'repos/owner/repo/pulls/99'))
    assert error.startswith('could not run gh: '), error


def test_invalid_gh_status_line_is_reported(tmp):
    _assert_script_error(
        tmp, _script_fixtures(bad_status=True),
        'could not read gh response: no HTTP status in output')


def test_non_json_gh_body_is_reported(tmp):
    _assert_script_error(
        tmp, _script_fixtures(non_json=True),
        'could not parse gh response body')


def test_gh_response_requires_a_header_body_separator(tmp):
    _assert_script_error(
        tmp, _script_fixtures(no_separator=True),
        'could not read gh response headers')


def test_gh_response_rejects_an_unknown_media_type(tmp):
    _assert_script_error(
        tmp, _script_fixtures(unsupported_media=True),
        'unsupported gh response media type: application/octet-stream')


def test_gh_response_rejects_duplicate_content_type(tmp):
    _assert_script_error(
        tmp, _script_fixtures(duplicate_content_type=True),
        'duplicate gh response header: content-type')


def test_reasonless_status_line_is_accepted(tmp):
    result, calls = _run_script(tmp, _script_fixtures(no_reason=True))
    assert (result.returncode, _recorded_writes(calls)) == (0, [])


def test_paginated_page_must_be_a_list(tmp):
    del tmp
    gate = _gate_module()
    api = _PaginationApi([gate.Response(200, {'items': []})])
    error = _runtime_error(
        lambda: gate.GhApi.paginate(api, 'repos/x/issues/1/comments'))
    assert error == 'paginated gh response is not a list'


def test_pagination_short_page_uses_safe_fields(tmp):
    del tmp
    gate = _gate_module()
    api = _PaginationApi([gate.Response(200, [1, 2])])
    response = gate.GhApi.paginate(api, 'repos/x/issues/1/comments')
    assert response == gate.Response(200, [1, 2])
    assert api.calls == [
        ('GET', 'repos/x/issues/1/comments', None,
         ('per_page=100', 'page=1'))]


def test_executable_pagination_advances_page_fields(tmp):
    comments = [{} for _index in range(201)]
    result, calls = _run_script(
        tmp, _script_fixtures(comments=comments))
    assert result.returncode == 0, (result.stdout, result.stderr, calls)
    assert _comment_page_fields(calls) == ['page=1', 'page=2', 'page=3']


def test_non_200_second_page_fails_without_writes(tmp):
    _assert_script_error(
        tmp, _script_fixtures(comments=[{}] * 150, fail_page=2),
        'GitHub returned 500 for repos/owner/repo/issues/99/comments')


def test_pagination_stops_after_fifty_full_pages(tmp):
    del tmp
    gate = _gate_module()
    pages = [gate.Response(200, list(range(100))) for _ in range(51)]
    api = _PaginationApi(pages)
    error = _runtime_error(
        lambda: gate.GhApi.paginate(api, 'repos/x/issues/1/comments'))
    assert error == 'gh pagination exceeded 50 pages'
    assert len(api.calls) == 50
    assert api.calls[0][3][-1] == 'page=1'
    assert api.calls[-1][3][-1] == 'page=50'


def test_paginate_runtime_error_is_reported_by_run(tmp):
    del tmp
    api = _api(paginate_error='boom')
    code, writes, _output, error = _execute_without_runtime_escape(
        api, _valid_body())
    assert code == 1
    _assert_no_writes(writes)
    assert error == 'pr gate failed: boom\n'


def test_runtime_error_is_reported_by_run(tmp):
    del tmp
    api = _api()

    def fail_request(_method, _endpoint, _payload=None):
        raise RuntimeError('transport unavailable')

    api.request = fail_request
    code, writes, _output, error = _execute(api, _valid_body())
    assert code == 1
    _assert_no_writes(writes)
    assert error == 'pr gate failed: transport unavailable\n'


def test_pull_response_must_be_an_object(tmp):
    del tmp
    gate = _gate_module()
    api = _api()
    request = api.request

    def wrong_pull(method, endpoint, payload=None):
        if method == 'GET' and endpoint.endswith('/pulls/99'):
            return gate.Response(200, [])
        return request(method, endpoint, payload)

    api.request = wrong_pull
    code, writes, _output, error = _execute(api, _valid_body())
    assert code == 1
    _assert_no_writes(writes)
    assert error == 'pr gate failed: pull request response is not an object\n'


def test_markdown_response_must_be_text(tmp):
    del tmp
    code, writes, _output, error = _execute(
        _api(rendered={'html': 'not text'}), _valid_body())
    assert code == 1
    _assert_no_writes(writes)
    assert error == 'pr gate failed: markdown response is not text\n'


def test_main_reports_missing_repo(tmp):
    del tmp
    gate = _gate_module()
    with mock.patch.dict(os.environ):
        os.environ.pop('REPO', None)
        code, output, error = _capture(gate.main)
    assert code == 1
    assert output == ''
    assert error == "pr gate failed: 'REPO'\n"


def test_gh_stub_refuses_unmodelled_calls(tmp):
    directory, command = _write_gh_stub(tmp)
    fixtures = Path(tmp) / 'fixtures.json'
    fixtures.write_text('{}', encoding='utf-8')
    calls = Path(tmp) / 'calls.jsonl'
    calls.write_text('', encoding='utf-8')
    environment = {
        **os.environ,
        'PATH': f'{directory}{os.pathsep}{os.environ["PATH"]}',
        'STUB_FIXTURES': str(fixtures),
        'STUB_CALLS': str(calls),
    }
    result = subprocess.run(
        [str(command), 'api', 'repos/owner/repo/labels'],
        env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 2, (result.stdout, result.stderr)
    assert 'unsupported' in result.stderr, result.stderr

    stub = directory / ('gh.py' if os.name == 'nt' else 'gh')
    result = subprocess.run(
        [sys.executable, str(stub), 'api', '--include', '-X', 'GET',
         'repos/owner/repo/issues/99/comments?per_page=100&page=1'],
        env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 2, (result.stdout, result.stderr)
    assert 'unsupported' in result.stderr, result.stderr


def test_unparsable_gh_failure_reports_one_stderr_line(tmp):
    fixtures = _script_fixtures(unparsable=True)
    result, _calls = _run_script(tmp, fixtures)
    assert result.returncode == 1, (result.stdout, result.stderr)
    assert result.stderr.splitlines() == [
        'pr gate failed: could not read gh response: first gh failure line '
        'second gh failure line'], result.stderr


def main():
    return _util.runner(
        _util.collect(globals()), tmp_prefix='prgate_')


if __name__ == '__main__':
    raise SystemExit(main())
