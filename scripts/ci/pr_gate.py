#!/usr/bin/env python3
"""Apply the pull-request body admission gate through GitHub's API."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

if __package__:
    from .pr_content import bug_issue_errors, section_content
    # pylint: disable-next=relative-beyond-top-level
    from .pr_body import (
        closing_issues, code_span, layout_errors, parse_rendered,
        referenced_issues, related_may_reference,
        retains_instruction_comment,
    )
else:
    from pr_content import bug_issue_errors, section_content
    from pr_body import (
        closing_issues, code_span, layout_errors, parse_rendered,
        referenced_issues, related_may_reference,
        retains_instruction_comment,
    )


ROOT = Path(__file__).resolve().parents[2]
BOT = 'github-actions[bot]'
MARKER = '<!-- pr-gate -->'
CLOSED_MARKER = '<!-- pr-gate: closed -->'
OVERFLOW_REASON = (
    'This body names more than 20 issue references, so only the first 20 '
    'were checked.')
UNCLAIMED_REASON = 'No checked issue is assigned to you.'
INSTRUCTION_REASON = 'Remove the template instruction comments.'
_STATUS_LINE = re.compile(r'^HTTP/\S+ ([0-9]{3})(?: |$)')
_NO_CLOSER = object()


class Response(NamedTuple):
    status: int
    data: object


class GhApi:
    """Runs `gh api`. request() never raises for an HTTP status; it raises
    RuntimeError only when gh could not be run or its output is unparsable.
    """

    def __init__(self):
        self.gh = shutil.which('gh')

    def request(self, method: str, endpoint: str,
                payload: dict | None = None) -> Response:
        return self._request(method, endpoint, payload)

    def _request(self, method, endpoint, payload=None, fields=()):
        if self.gh is None:
            raise RuntimeError('gh was not found on PATH')
        arguments = [
            self.gh, 'api', '--include', '-X', method, endpoint]
        for field in fields:
            arguments.extend(('-f', field))
        with tempfile.TemporaryDirectory(prefix='pr-gate-') as directory:
            if payload:
                path = Path(directory) / 'payload.json'
                path.write_text(json.dumps(payload), encoding='utf-8')
                arguments.extend(('--input', str(path)))
            try:
                completed = subprocess.run(
                    arguments, capture_output=True, text=True,
                    check=False)
            except OSError as error:
                raise RuntimeError(f'could not run gh: {error}') from error
        lines = completed.stdout.splitlines()
        match = _STATUS_LINE.match(lines[0]) if lines else None
        if match is None:
            detail = (' '.join(completed.stderr.split())
                      or 'no HTTP status in output')
            raise RuntimeError(f'could not read gh response: {detail}')
        try:
            separator = lines.index('')
        except ValueError as error:
            raise RuntimeError('could not read gh response headers') from error
        headers = {}
        for line in lines[1:separator]:
            name, found, value = line.partition(':')
            if found:
                key = name.lower()
                if key == 'content-type' and key in headers:
                    raise RuntimeError(
                        'duplicate gh response header: content-type')
                headers[key] = value.strip()
        body = '\n'.join(lines[separator + 1:])
        media_type = headers.get('content-type', '').partition(';')[0].lower()
        if media_type == 'text/html':
            data = body
        elif media_type == 'application/json' or media_type.endswith('+json'):
            try:
                data = json.loads(body) if body else None
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    'could not parse gh response body') from error
        else:
            detail = media_type or 'missing'
            raise RuntimeError(
                f'unsupported gh response media type: {detail}')
        return Response(int(match.group(1)), data)

    def paginate(self, endpoint: str) -> Response:
        items = []
        for page in range(1, 51):
            response = self._request(
                'GET', endpoint,
                fields=('per_page=100', f'page={page}'))
            if response.status != 200:
                return response
            if not isinstance(response.data, list):
                raise RuntimeError('paginated gh response is not a list')
            items.extend(response.data)
            if len(response.data) < 100:
                return Response(200, items)
        raise RuntimeError('gh pagination exceeded 50 pages')


class _GateError(RuntimeError):
    pass


def _response(api, method, endpoint, payload=None):
    try:
        response = api.request(method, endpoint, payload)
    except RuntimeError as error:
        raise _GateError(str(error)) from error
    return response


def _page(api, endpoint):
    try:
        response = api.paginate(endpoint)
    except RuntimeError as error:
        raise _GateError(str(error)) from error
    if response.status != 200 or not isinstance(response.data, list):
        raise _GateError(f'GitHub returned {response.status} for {endpoint}')
    return response.data


def _read(api, method, endpoint, payload=None):
    response = _response(api, method, endpoint, payload)
    if response.status != 200:
        raise _GateError(f'GitHub returned {response.status} for {endpoint}')
    return response.data


def _write(api, method, endpoint, payload):
    response = _response(api, method, endpoint, payload)
    if not 200 <= response.status < 300:
        raise _GateError(f'GitHub returned {response.status} for {endpoint}')


def _gate_comment(comments):
    for comment in comments:
        user = comment.get('user') or {}
        body = comment.get('body') or ''
        lines = (line.rstrip('\r') for line in body.splitlines())
        if user.get('login') == BOT and MARKER in lines:
            return comment
    return None


def _closed_by_gate(timeline, comment):
    actor = _latest_closer(timeline)
    body = (comment or {}).get('body') or ''
    lines = (line.rstrip('\r') for line in body.splitlines())
    return actor == BOT and CLOSED_MARKER in lines


def _latest_closer(timeline):
    closed = [event for event in timeline if event.get('event') == 'closed']
    return ((closed[-1].get('actor') or {}).get('login')
            if closed else None)


def _revalidate(api, pull_endpoint, state, timeline_endpoint=None,
                closer=_NO_CLOSER):
    pull = _read(api, 'GET', pull_endpoint)
    if not isinstance(pull, dict):
        raise _GateError('pull request response is not an object')
    current_closer = _NO_CLOSER
    if timeline_endpoint is not None:
        timeline = _page(api, timeline_endpoint)
        current_closer = _latest_closer(timeline)
    if pull.get('merged'):
        raise _GateError('pull request was merged during analysis')
    if pull.get('state') != state:
        raise _GateError('pull request state changed during analysis')
    if closer is not _NO_CLOSER and current_closer != closer:
        raise _GateError('pull request closer changed during analysis')
    return current_closer


def _issue_records(api, repo, numbers):
    records = {}
    for number in numbers[:20]:
        endpoint = f'repos/{repo}/issues/{number}'
        response = _response(api, 'GET', endpoint)
        if response.status == 404:
            records[number] = None
            continue
        if response.status != 200 or not isinstance(response.data, dict):
            raise _GateError(
                f'GitHub returned {response.status} for {endpoint}')
        records[number] = response.data
    return records


def _claim(issues, closing, actor, records):
    claimed = None
    unassigned = []
    for number in issues[:20]:
        issue = records[number]
        if issue is None or 'pull_request' in issue:
            continue
        assignees = issue.get('assignees') or []
        if any(item.get('login') == actor for item in assignees):
            claimed = claimed or number
        elif number in closing:
            unassigned.append(number)
    return claimed, unassigned


def _unassigned_reason(numbers):
    # The numbers are code-spanned: a bare #N in a posted comment is a live
    # issue reference, and the gate must not cross-reference the very issues
    # it is refusing on behalf of.
    quoted = [code_span(f'#{number}') for number in numbers]
    if len(quoted) == 1:
        names = quoted[0]
    else:
        names = ', '.join(quoted[:-1]) + f' and {quoted[-1]}'
    label = 'Issues' if len(quoted) > 1 else 'Issue'
    verb = 'are' if len(quoted) > 1 else 'is'
    return f'{label} {names} {verb} not assigned to you.'


def _reasons_block(reasons):
    return '\n'.join(f'- {reason}' for reason in reasons)


def _inadmissible_text(actor, reasons, closed):
    if closed:
        opening = (
            f'@{actor} — closing this automatically; it is recoverable, '
            'read on.\n'
            f'{MARKER}\n{CLOSED_MARKER}')
        ending = (
            'The gate re-checks every edit of this closed pull request and '
            'reopens it\nautomatically once every condition passes. Nothing '
            'here is lost.')
    else:
        opening = (
            f'@{actor} — this pull request needs changes before it can be '
            f'reviewed.\n{MARKER}')
        ending = (
            'The gate re-checks every edit; there is no need to open a second '
            'pull\nrequest.')
    return f"""{opening}

{_reasons_block(reasons)}

Fix every item above, including these two repository requirements:

1. Comment `/claim` on the issue you are fixing. That assigns it to you,
   no write access needed — see CONTRIBUTING.md.
2. Edit this same pull request so its sections match the pull request
   template. Its **Related Issues and Pull Requests** section must name
   the claimed issue by its real number. Any reference counts, so write
   `Fixes #<issue>` when merging this should close the issue and
   `References #<issue>` when it should not.

{ending}
"""


def _reopen_text(actor):
    return (
        f'@{actor} — the body now names a claimed issue and matches '
        'the pull request\ntemplate, so I am reopening it automatically.\n'
        f'{MARKER}\n')


def _resolved_text(actor):
    return (
        f'@{actor} — every condition now passes; nothing further is needed '
        f'from you.\n{MARKER}\n')


def _write_comment(api, repo, pr, comment, body):
    if comment is None:
        endpoint = f'repos/{repo}/issues/{pr}/comments'
        _write(api, 'POST', endpoint, {'body': body})
    else:
        endpoint = f"repos/{repo}/issues/comments/{comment['id']}"
        _write(api, 'PATCH', endpoint, {'body': body})


def _run(api, repo, pr, actor, template):
    pull_endpoint = f'repos/{repo}/pulls/{pr}'
    pull = _read(api, 'GET', pull_endpoint)
    if not isinstance(pull, dict):
        raise _GateError('pull request response is not an object')
    body = pull.get('body') or ''
    state = pull.get('state')
    if pull.get('merged'):
        print('nothing to do')
        return 0

    comments = _page(
        api, f'repos/{repo}/issues/{pr}/comments')
    comment = _gate_comment(comments)
    timeline_endpoint = f'repos/{repo}/issues/{pr}/timeline'
    closer = None
    if state == 'closed':
        timeline = _page(api, timeline_endpoint)
        closer = _latest_closer(timeline)
        if not _closed_by_gate(timeline, comment):
            print(f'pull request {pr} was not closed by the gate')
            return 0

    rendered = _read(
        api, 'POST', 'markdown',
        {'text': body, 'mode': 'gfm', 'context': repo})
    if not isinstance(rendered, str):
        raise _GateError('markdown response is not text')
    try:
        parsed = parse_rendered(rendered, repo)
    except ValueError as error:
        raise _GateError(
            f'could not analyze rendered body: {error}') from error
    sections = parsed.sections

    layout = layout_errors(sections, template) + list(parsed.notes)
    if retains_instruction_comment(body, template):
        layout.append(INSTRUCTION_REASON)
    content_errors, bug_pointers = section_content(body, sections)
    layout.extend(content_errors)
    references = referenced_issues(sections)
    closing = closing_issues(parsed)
    known = set(references)
    for number in closing:
        if number not in known:
            known.add(number)
            references.append(number)
    all_references = list(dict.fromkeys([
        *references, *(number for number, _title in bug_pointers)]))
    records = _issue_records(api, repo, all_references)
    claimed, unassigned = _claim(references, set(closing), actor, records)
    layout.extend(bug_issue_errors(bug_pointers, records))
    reasons = list(layout)
    if len(all_references) > 20:
        reasons.append(OVERFLOW_REASON)
    elif unassigned:
        reasons.append(_unassigned_reason(unassigned))
    elif claimed is None:
        reasons.append(UNCLAIMED_REASON)
    closable = bool(layout) or not related_may_reference(
        body, sections, template)

    if not reasons:
        if state == 'closed':
            _revalidate(
                api, pull_endpoint, state, timeline_endpoint, closer)
            # Keep close ownership through every fallible reopen boundary.
            # A retry can finish the transition or reconcile an already-open PR.
            _write_comment(
                api, repo, pr, comment,
                _reopen_text(actor) + f'{CLOSED_MARKER}\n')
            _revalidate(
                api, pull_endpoint, state, timeline_endpoint, closer)
            _write(api, 'PATCH', pull_endpoint, {'state': 'open'})
            _revalidate(
                api, pull_endpoint, 'open', timeline_endpoint, closer)
            _write_comment(api, repo, pr, comment, _reopen_text(actor))
            print('reopened')
        elif comment is not None:
            _revalidate(api, pull_endpoint, state)
            _write_comment(api, repo, pr, comment, _resolved_text(actor))
            print(f'covered by claimed issue {claimed}')
        else:
            print(f'covered by claimed issue {claimed}')
        return 0

    if state == 'closed':
        _revalidate(
            api, pull_endpoint, state, timeline_endpoint, closer)
        _write_comment(
            api, repo, pr, comment,
            _inadmissible_text(actor, reasons, True))
        print('commented')
        return 0

    if closable:
        closer = _revalidate(
            api, pull_endpoint, state, timeline_endpoint)
    else:
        _revalidate(api, pull_endpoint, state)
    _write_comment(
        api, repo, pr, comment,
        _inadmissible_text(actor, reasons, closable))
    if closable:
        _revalidate(
            api, pull_endpoint, state, timeline_endpoint, closer)
        _write(api, 'PATCH', pull_endpoint, {'state': 'closed'})
        print('closed')
    else:
        print('commented')
    return 0


def run(api, repo: str, pr: str, actor: str, template: str) -> int:
    try:
        return _run(api, repo, pr, actor, template)
    except _GateError as error:
        print(f'pr gate failed: {error}', file=sys.stderr)
        return 1


def main() -> int:
    try:
        repo = os.environ['REPO']
        pr = os.environ['PR']
        actor = os.environ['ACTOR']
        template = (ROOT / '.github' / 'PULL_REQUEST_TEMPLATE.md').read_text(
            encoding='utf-8')
    except (KeyError, OSError) as error:
        print(f'pr gate failed: {error}', file=sys.stderr)
        return 1
    return run(GhApi(), repo, pr, actor, template)


if __name__ == '__main__':
    raise SystemExit(main())
