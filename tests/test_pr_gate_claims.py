#!/usr/bin/env python3
"""Pull-request gate claim checking: every closing reference assigned."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _prgate import (  # noqa: E402
    CLOSED_FIRST, GITHUB_HTML, OPEN_FIRST, _api, _assert_gate_message,
    _assert_no_writes, _execute, _issue, _issue_gets,
    _issue_html, _html_body, _layout_body, _markdown_code_spans, _text_html,
    _comment_body, _valid_body, _valid_html, _write_sequence,
)
import _util  # noqa: E402


def _assert_numbers_code_spanned(comment):
    """No bare issue reference may survive in a reason the gate posts."""
    spans = _markdown_code_spans(comment)
    for match in re.finditer(r'#\d+', comment):
        assert any(start <= match.start() < end for start, end in spans), (
            match.start(), spans, comment)


def test_first_claimed_second_unassigned_names_the_second(tmp):
    del tmp
    rendered = _valid_html(references=(
        f'Fixes {_issue_html(101)}\n'
        f'Fixes {_issue_html(104)}'))
    api = _api(
        issues={'101': _issue('alice'), '104': _issue('bob')},
        rendered=rendered)
    code, writes, _output, _error = _execute(
        api, _valid_body('Fixes #101\nFixes #104'))
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['Issue `#104` is not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_two_unassigned_closing_issues_are_named_together(tmp):
    del tmp
    rendered = _valid_html(references=(
        f'Fixes {_issue_html(101)}\n'
        f'Fixes {_issue_html(104)}\n'
        f'Fixes {_issue_html(105)}'))
    api = _api(
        issues={
            '101': _issue('alice'), '104': _issue('bob'),
            '105': _issue('carol')},
        rendered=rendered)
    code, writes, _output, _error = _execute(
        api, _valid_body('Fixes #101\nFixes #104\nFixes #105'))
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST,
        ['Issues `#104` and `#105` are not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_a_punctuated_closing_keyword_still_needs_the_claim(tmp):
    """The bypass this recognition exists to close.

    Each spelling closes its issue when the pull request merges, so a
    gate reading it as an ordinary mention lets an author close an
    issue assigned to somebody else.
    """
    del tmp
    failures = []
    for spelling in ('(Fixes', 'hot-fixes', 'Fixes :'):
        rendered = _valid_html(references=(
            f'Fixes {_issue_html(101)}\n'
            f'{spelling} {_issue_html(104)}'))
        api = _api(
            issues={'101': _issue('alice'), '104': _issue('bob')},
            rendered=rendered)
        code, writes, _output, _error = _execute(
            api, _valid_body(f'Fixes #101\n{spelling} #104'))
        try:
            assert code == 0, 'the gate exited nonzero'
            assert _write_sequence(writes) == [
                ('POST', 'repos/owner/repo/issues/99/comments')], (
                    'the gate did not comment exactly once')
            _assert_gate_message(
                writes[0], OPEN_FIRST,
                ['Issue `#104` is not assigned to you.'])
            _assert_numbers_code_spanned(_comment_body(writes[0]))
        except AssertionError as error:
            failures.append((spelling, error))
    assert failures == [], failures


def test_unassigned_mention_without_keyword_passes(tmp):
    del tmp
    rendered = _valid_html(references=(
        f'Fixes {_issue_html(101)}\n'
        f'References {_issue_html(104)}'))
    api = _api(
        issues={'101': _issue('alice'), '104': _issue('bob')},
        rendered=rendered)
    code, writes, _output, _error = _execute(
        api, _valid_body('Fixes #101\nReferences #104'))
    assert code == 0
    _assert_no_writes(writes)


def test_closing_keyword_outside_related_is_checked(tmp):
    del tmp
    summary = f'<p dir="auto">Also fixes {_issue_html(104)}.</p>'
    rendered = _valid_html().replace(_text_html('One sentence.'), summary)
    api = _api(
        issues={'101': _issue('alice'), '104': _issue('bob')},
        rendered=rendered)
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['Issue `#104` is not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_duplicate_closing_reference_is_looked_up_once(tmp):
    del tmp
    summary = (
        f'<p dir="auto">Fixes {_issue_html(104)}. Again '
        f'fixes {_issue_html(104)}.</p>')
    rendered = _valid_html(references=(
        f'Fixes {_issue_html(101)}')).replace(
            _text_html('One sentence.'), summary)
    api = _api(
        issues={'101': _issue('alice'), '104': _issue('bob')},
        rendered=rendered)
    body = _valid_body('Fixes #101').replace(
        'One sentence.', 'Fixes #104. Again fixes #104.')
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert len(_issue_gets(api)) == 2
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['Issue `#104` is not assigned to you.'])


def test_keyword_overflow_reports_overflow_only(tmp):
    del tmp
    numbers = list(range(101, 122))
    body = _valid_body(' '.join(f'Fixes #{number}' for number in numbers))
    rendered = _valid_html(references=' '.join(
        f'Fixes {_issue_html(number)}' for number in numbers))
    issues = {str(number): _issue('bob') for number in numbers}
    api = _api(issues=issues, rendered=rendered)
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert len(_issue_gets(api)) == 20
    reason = ('This body names more than 20 issue references, so only the '
              'first 20 were checked.')
    comment = _assert_gate_message(writes[0], OPEN_FIRST, [reason])
    assert 'not assigned to you' not in comment

    numbers = numbers[:20]
    body = _valid_body(' '.join(f'Fixes #{number}' for number in numbers))
    rendered = _valid_html(references=' '.join(
        f'Fixes {_issue_html(number)}' for number in numbers))
    api = _api(issues=issues, rendered=rendered)
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert len(_issue_gets(api)) == 20
    assert reason not in _comment_body(writes[0])


def test_unclaimed_issue_comments_naming_the_issue(tmp):
    del tmp
    api = _api(issues={'101': _issue('bob')})
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['Issue `#101` is not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_three_unassigned_closing_issues_are_named_together(tmp):
    del tmp
    rendered = _valid_html(references='\n'.join(
        f'Fixes {_issue_html(number)}'
        for number in (101, 104, 105, 106)))
    api = _api(
        issues={
            '101': _issue('alice'), '104': _issue('bob'),
            '105': _issue('carol'), '106': _issue('dave')},
        rendered=rendered)
    body = _valid_body(
        'Fixes #101\nFixes #104\nFixes #105\nFixes #106')
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST,
        ['Issues `#104`, `#105` and `#106` are not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_missing_issue_comments_without_closing(tmp):
    del tmp
    code, writes, _output, _error = _execute(
        _api(issues={}), _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['No checked issue is assigned to you.'])


def test_pull_request_reference_comments_without_closing(tmp):
    del tmp
    api = _api(issues={'101': _issue(pull_request=True)})
    code, writes, _output, _error = _execute(api, _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['No checked issue is assigned to you.'])


def test_layout_failure_with_reference_comments_then_closes(tmp):
    del tmp
    body = _layout_body(
        ('Related Issues and Pull Requests', 'Fixes #101'),
        ('Changes', '- One change'),
        ('Testing', 'Ran the suite.'))
    rendered = _html_body(
        ('Related Issues and Pull Requests', f'Fixes {_issue_html(101)}'),
        ('Changes', _text_html('One change')),
        ('Testing', _text_html('Ran the suite.')))
    code, writes, _output, _error = _execute(
        _api(rendered=rendered), body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['Required section "Summary" is missing.'], closed=True)
    assert writes[1][2] == {'state': 'closed'}


def test_related_without_reference_comments_then_closes(tmp):
    del tmp
    body = _valid_body('see the tracker')
    rendered = _valid_html(references=_text_html('see the tracker'))
    code, writes, _output, _error = _execute(
        _api(issues={}, rendered=rendered), body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['No checked issue is assigned to you.'], closed=True)


def test_reference_outside_related_does_not_protect_from_close(tmp):
    del tmp
    body = _valid_body('none').replace(
        'One sentence.', 'Summary references #101.')
    summary = f'<p dir="auto">Summary references {_issue_html(101)}.</p>'
    rendered = _valid_html(references=_text_html('none')).replace(
        _text_html('One sentence.'), summary)
    code, writes, _output, _error = _execute(
        _api(issues={}, rendered=rendered), body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['No checked issue is assigned to you.'], closed=True)


def test_fenced_reference_protects_from_close_without_lookup(tmp):
    del tmp
    body = _valid_body('```\nFixes #101\n```')
    rendered = _valid_html(references=GITHUB_HTML['fenced_code'])
    api = _api(issues={}, rendered=rendered)
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['No checked issue is assigned to you.'])
    assert _issue_gets(api) == []


def test_issue_lookup_failure_fails_without_writes(tmp):
    del tmp
    api = _api(fail={'issues/101'})
    code, writes, _output, error = _execute(api, _valid_body())
    assert code == 1
    _assert_no_writes(writes)
    assert error == (
        'pr gate failed: GitHub returned 500 for '
        'repos/owner/repo/issues/101\n')


def test_preamble_closing_reference_is_checked(tmp):
    del tmp
    rendered = (
        '<p dir="auto">Fixes ' + _issue_html(104) + '</p>\n'
        + _valid_html())
    api = _api(
        issues={'101': _issue('alice'), '104': _issue('bob')},
        rendered=rendered)
    code, writes, _output, _error = _execute(
        api, 'Fixes #104\n\n' + _valid_body())
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['Issue `#104` is not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_heading_closing_reference_is_checked(tmp):
    del tmp
    rendered = (
        _valid_html()
        + f'\n<h2 dir="auto">Fixes {_issue_html(105)}</h2>\n'
        + _text_html('Ran the suite.'))
    api = _api(
        issues={'101': _issue('alice'), '105': _issue('bob')},
        rendered=rendered)
    body = _valid_body() + '\n## Fixes #105\n\nRan the suite.\n'
    code, writes, _output, _error = _execute(api, body)
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    _assert_gate_message(
        writes[0], CLOSED_FIRST,
        ['Section `Fixes #105` is not defined by the template.',
         'Issue `#105` is not assigned to you.'], closed=True)
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def test_comma_separated_closing_list_is_checked(tmp):
    del tmp
    rendered = _valid_html(references=(
        f'Fixes {_issue_html(101)}, {_issue_html(104)}'))
    api = _api(
        issues={'101': _issue('alice'), '104': _issue('bob')},
        rendered=rendered)
    code, writes, _output, _error = _execute(
        api, _valid_body('Fixes #101, #104'))
    assert code == 0
    assert _write_sequence(writes) == [
        ('POST', 'repos/owner/repo/issues/99/comments')]
    _assert_gate_message(
        writes[0], OPEN_FIRST, ['Issue `#104` is not assigned to you.'])
    _assert_numbers_code_spanned(_comment_body(writes[0]))


def main():
    return _util.runner(
        _util.collect(globals()), tmp_prefix='prgateclaims_')


if __name__ == '__main__':
    raise SystemExit(main())
