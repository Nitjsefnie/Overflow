#!/usr/bin/env python3
"""Shared fixtures for pull-request body and workflow gate tests."""
import contextlib
import html
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util  # noqa: E402
# pylint: disable-next=unused-import
from _prgate_message import (  # noqa: E402
    BOT, CLOSED_FIRST, CLOSED_MARKER, MARKER, OPEN_FIRST, REOPEN_FIRST,
    RESOLVED_FIRST, _assert_gate_message, _assert_no_writes,
    _comment_body,
)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


PR_BODY = _util.load(
    ROOT / 'scripts' / 'ci' / 'pr_body.py', 'scripts.ci.pr_body')
PR_BODY_CLOSING = _util.load(
    ROOT / 'scripts' / 'ci' / 'pr_body_closing.py',
    'scripts.ci.pr_body_closing')
# Preserve the contract accompanying the historical GitHub renderings below.
# Overflow's distinct shipped contract is tested in test_pr_body_overflow.py;
# CLI fixtures below include its required Footer because main reads that file.
TEMPLATE = '''## Summary
<!-- required:
explain the change
-->
## Related Issues and Pull Requests
<!-- required: name the related work -->
## Changes
<!-- required: list the changes -->
## Testing
<!-- required: report verification -->
## Bugs Discovered
<!-- conditional: list filed bugs -->
## Breaking Changes
<!-- optional: describe compatibility changes -->
## Follow-ups / Known Limitations
<!-- optional: describe limitations -->
## Dependencies
<!-- optional: list dependencies -->
## Footer
<!-- optional: attribute the report -->
'''
GITHUB_ISSUE_101 = (
    '<a class="issue-link js-issue-link" '
    'data-error-text="Failed to load title" data-id="5232098400" '
    'data-permission-text="Title is private" '
    'data-url="https://github.com/Nitjsefnie-Harness-Commons/'
    'daedalus/issues/101" data-hovercard-type="issue" '
    'data-hovercard-url="/Nitjsefnie-Harness-Commons/daedalus/'
    'issues/101/hovercard" href="https://github.com/'
    'Nitjsefnie-Harness-Commons/daedalus/issues/101">#101</a>')

# Captured from GitHub's /markdown endpoint in GFM mode with
# Nitjsefnie-Harness-Commons/daedalus as the context.
GITHUB_ISSUE_104 = (
    '<a class="issue-link js-issue-link" data-error-text="Failed to load '
    'title" data-id="5232205124" data-permission-text="Title is private" '
    'data-url="https://github.com/Nitjsefnie-Harness-Commons/daedalus/issues'
    '/104" data-hovercard-type="issue" '
    'data-hovercard-url="/Nitjsefnie-Harness-Commons/daedalus/issues/104/hov'
    'ercard" '
    'href="https://github.com/Nitjsefnie-Harness-Commons/daedalus/issues/104'
    '">#104</a>')

GITHUB_FOOTNOTE_HTML = (
    '<h2 dir="auto">Summary</h2>\n'
    '<p dir="auto">One sentence.</p>\n'
    '<h2 dir="auto">Related Issues and Pull Requests</h2>\n'
    f'<p dir="auto">Fixes {GITHUB_ISSUE_101}</p>\n'
    '<h2 dir="auto">Changes</h2>\n'
    '<p dir="auto">The behavior is pinned.<sup><a href="'
    '#user-content-fn-1-994fe5c1980496529dc0a26cdffba501" id="'
    'user-content-fnref-1-994fe5c1980496529dc0a26cdffba501" '
    'data-footnote-ref="" aria-describedby="footnote-label">1</a>'
    '</sup></p>\n<h2 dir="auto">Testing</h2>\n'
    '<p dir="auto">Ran the suite.</p>\n'
    '<section data-footnotes="" class="footnotes"><h2 '
    'id="footnote-label" class="sr-only" dir="auto">Footnotes</h2>\n'
    '<ol dir="auto">\n<li id="user-content-fn-1-'
    '994fe5c1980496529dc0a26cdffba501">\n'
    '<p dir="auto">By a focused regression test. <a href="'
    '#user-content-fnref-1-994fe5c1980496529dc0a26cdffba501" '
    'data-footnote-backref="" aria-label="Back to reference 1" '
    'class="data-footnote-backref">↩</a></p>\n</li>\n</ol>\n'
    '</section>')

# These fragments are responses captured from GitHub's /markdown endpoint in
# GFM mode with Nitjsefnie-Harness-Commons/daedalus as the context.
GITHUB_HTML = {
    'nested_list': (
        '<ul dir="auto">\n<li>Tracking:\n<ul dir="auto">\n'
        f'<li>Fixes {GITHUB_ISSUE_101}</li>\n'
        '</ul>\n</li>\n</ul>'),
    'paragraph_continuation': (
        '<p dir="auto">This fixes the tracked bug,<br>\n'
        f'Fixes {GITHUB_ISSUE_101}</p>'),
    'escaped_backticks': (
        '<p dir="auto">Literal backticks: `Fixes '
        f'{GITHUB_ISSUE_101}`</p>'),
    'angle_prose': (
        '<p dir="auto">Fixes &lt;issue '
        f'{GITHUB_ISSUE_101}&gt;</p>'),
    'undefined_reference': (
        '<p dir="auto">[documentation][issue '
        f'{GITHUB_ISSUE_101}]</p>'),
    'malformed_inline': (
        '<p dir="auto">[documentation](issue '
        f'{GITHUB_ISSUE_101})</p>'),
    'balanced_destination': (
        '<p dir="auto"><a href="https://example.com/a_(b)#101" '
        'rel="nofollow">documentation</a></p>'),
    'quoted_attribute': (
        '<p dir="auto"><a title="1 &gt; 0" href="#101">'
        'documentation</a></p>'),
    'multiline_attribute': (
        '<p dir="auto"><a href="#101" title="documentation">'
        'docs</a></p>'),
    'image_destination': (
        '<p dir="auto"><a target="_blank" rel="noopener noreferrer" '
        'href=""><img src="" alt="documentation" '
        'style="max-width: 100%;"></a></p>'),
    'empty_image': (
        '<p dir="auto"><a target="_blank" rel="noopener noreferrer" '
        'href=""><img src="" alt="" '
        'style="max-width: 100%;"></a></p>'),
    'kbd_block': '<kbd>\n## literal heading\n</kbd>',
    'empty_list': '<ul dir="auto">\n<li></li>\n</ul>',
    'empty_ordered': '<ol dir="auto">\n<li></li>\n</ol>',
    'empty_quote': '<blockquote>\n</blockquote>',
    'link_definition': '',
    'inline_code': (
        '<p dir="auto"><code class="notranslate">Fixes #101'
        '</code></p>'),
    'fenced_code': (
        '<pre class="notranslate"><code class="notranslate">'
        'Fixes #101\n</code></pre>'),
    'indented_code': (
        '<pre class="notranslate"><code class="notranslate">'
        'Fixes #101\n</code></pre>'),
    'html_attribute': '<p dir="auto"><a href="#101">docs</a></p>',
    'inline_instruction': (
        '<ul dir="auto">\n<li>Changed <code class="notranslate">'
        '&lt;!-- required: bullet list of concrete changes — files, '
        'modules, behavior. --&gt;</code> to prose.</li>\n</ul>'),
    'indented_instruction': (
        '<pre class="notranslate"><code class="notranslate">'
        '&lt;!-- required: bullet list of concrete changes — files, '
        'modules, behavior. --&gt;\n</code></pre>\n<ul dir="auto">\n'
        '<li>A visible change</li>\n</ul>'),
    'named_anchor': '<p dir="auto"><a name="user-content-spot"></a></p>',
    'entity_instruction': (
        '<ul dir="auto">\n'
        '<li>The literal template marker is &lt;!-- optional --&gt;.</li>\n'
        '<li>One change.</li>\n</ul>'),
    'zero_size_image': (
        '<p dir="auto"><a target="_blank" rel="noopener noreferrer" '
        'href=""><img alt="" width="0" height="0" '
        'style="max-width: 100%;"></a></p>'),
}


def _layout_body(*sections):
    return '\n\n'.join(
        f'## {title}\n{content}' for title, content in sections) + '\n'


def _html_body(*sections):
    return '\n'.join(
        f'<h2 dir="auto">{html.escape(title)}</h2>\n{content}'
        for title, content in sections)


def _issue_html(number, repo='owner/repo'):
    href = f'https://github.com/{repo}/issues/{number}'
    return f'<a href="{href}">#{number}</a>'


def _text_html(text):
    return f'<p dir="auto">{html.escape(text)}</p>' if text else ''


def _valid_body(references='Fixes #101'):
    return _layout_body(
        ('Summary', 'One sentence.'),
        ('Related Issues and Pull Requests', references),
        ('Changes', '- One change'),
        ('Testing', 'Ran the suite.'))


def _valid_html(references=None, changes=None, repo='owner/repo'):
    references = references or f'Fixes {_issue_html(101, repo)}'
    changes = changes if changes is not None else (
        '<ul dir="auto">\n<li>One change</li>\n</ul>')
    return _html_body(
        ('Summary', _text_html('One sentence.')),
        ('Related Issues and Pull Requests', references),
        ('Changes', changes),
        ('Testing', _text_html('Ran the suite.')))


GH_STUB = r'''#!/usr/bin/env python3
import json
import os
import re
import sys


def finish(status, data):
    reasons = {
        200: 'OK', 201: 'Created', 404: 'Not Found', 500: 'Error'}
    if status == 200 and fixtures.get('no_reason'):
        print(f'HTTP/2 {status}')
    else:
        print(f'HTTP/2.0 {status} {reasons.get(status, "Response")}')
    content_type = ('text/html; charset=utf-8'
                    if endpoint == 'markdown' else 'application/json')
    print(f'content-type: {content_type}')
    if fixtures.get('duplicate_content_type'):
        print(f'Content-Type: {content_type}')
    print()
    if data is not None:
        print(data if endpoint == 'markdown' else json.dumps(data))
    raise SystemExit(0 if 200 <= status < 300 else 1)


def unsupported():
    print('unsupported', file=sys.stderr)
    raise SystemExit(2)


arguments = sys.argv[1:]
payload = None
if (len(arguments) < 5 or arguments[0] != 'api'
        or arguments[1:3] != ['--include', '-X']):
    unsupported()
method = arguments[3]
endpoint = arguments[4]
fields = {}
tail = arguments[5:]
while tail:
    if len(tail) >= 2 and tail[0] == '-f' and '=' in tail[1]:
        key, value = tail[1].split('=', 1)
        fields[key] = value
        tail = tail[2:]
    elif len(tail) == 2 and tail[0] == '--input':
        with open(tail[1], encoding='utf-8') as handle:
            payload = json.load(handle)
        tail = []
    else:
        unsupported()
with open(os.environ['STUB_CALLS'], 'a', encoding='utf-8') as handle:
    handle.write(json.dumps({'argv': arguments, 'input': payload}) + '\n')
with open(os.environ['STUB_FIXTURES'], encoding='utf-8') as handle:
    fixtures = json.load(handle)
if fixtures.get('bad_status'):
    print('status unavailable')
    print()
    print('{}')
    raise SystemExit(0)
if fixtures.get('non_json'):
    print('HTTP/2.0 200 OK')
    print('content-type: application/json')
    print()
    print('not JSON')
    raise SystemExit(0)
if fixtures.get('no_separator'):
    print('HTTP/2.0 200 OK')
    print('content-type: application/json')
    raise SystemExit(0)
if fixtures.get('unsupported_media'):
    print('HTTP/2.0 200 OK')
    print('content-type: application/octet-stream')
    print()
    print('not an API representation')
    raise SystemExit(0)
if fixtures.get('unparsable'):
    print('first gh failure line', file=sys.stderr)
    print('second gh failure line', file=sys.stderr)
    raise SystemExit(2)
if any(item in f'{method} {endpoint}' for item in fixtures.get('fail', [])):
    finish(500, {'message': 'fixture failure'})
if endpoint == 'repos/owner/repo/pulls/99':
    if method == 'GET':
        finish(200, fixtures['pull'])
    if method == 'PATCH':
        finish(200, {**fixtures['pull'], **payload})
if endpoint == 'markdown' and method == 'POST':
    finish(200, fixtures['rendered'])
page = re.fullmatch(
    r'repos/owner/repo/issues/99/(comments|timeline)', endpoint)
if (page and method == 'GET' and fields.get('per_page') == '100'
        and fields.get('page', '').isdigit() and len(fields) == 2):
    if int(fields['page']) == fixtures.get('fail_page'):
        finish(500, {'message': 'fixture page failure'})
    values = fixtures[page.group(1)]
    offset = (int(fields['page']) - 1) * 100
    finish(200, values[offset:offset + 100])
issue = re.fullmatch(r'repos/owner/repo/issues/([0-9]+)', endpoint)
if issue and method == 'GET':
    value = fixtures['issues'].get(issue.group(1))
    finish(200, value) if value is not None else finish(404, None)
if endpoint == 'repos/owner/repo/issues/99/comments' and method == 'POST':
    finish(201, {'id': 100, **payload})
comment = re.fullmatch(
    r'repos/owner/repo/issues/comments/([0-9]+)', endpoint)
if comment and method == 'PATCH':
    finish(200, {'id': int(comment.group(1)), **payload})
unsupported()
'''


class _Response(NamedTuple):
    status: int
    data: object


def _issue(*assignees, pull_request=False):
    value = {'assignees': [{'login': login} for login in assignees]}
    if pull_request:
        value['pull_request'] = {}
    return value


class FakeApi:
    def __init__(self, *, pull, issues=None, comments=(), timeline=(),
                 rendered=None, fail=(), paginate_error=None):
        self.pull = pull
        self.issues = issues or {}
        self.comments = list(comments)
        self.next_comment_id = max(
            [99, *(item['id'] for item in self.comments)]) + 1
        self.timeline = list(timeline)
        self.rendered = _valid_html() if rendered is None else rendered
        self.fail = set(fail)
        self.paginate_error = paginate_error
        self.calls = []
        self.writes = []

    def _failed(self, method, endpoint):
        target = f'{method} {endpoint}'
        return any(fragment in target for fragment in self.fail)

    def request(self, method, endpoint, payload=None):
        call = (method, endpoint, payload)
        self.calls.append(call)
        if method != 'GET' and endpoint != 'markdown':
            self.writes.append(call)
        if self._failed(method, endpoint):
            return _Response(500, None)
        if endpoint == 'repos/owner/repo/pulls/99':
            if method == 'GET':
                return _Response(200, self.pull)
            if method == 'PATCH':
                self.pull['state'] = payload['state']
                event = ('closed' if payload['state'] == 'closed'
                         else 'reopened')
                self.timeline.append({
                    'event': event, 'actor': {'login': BOT}})
                return _Response(200, self.pull)
        if endpoint == 'markdown' and method == 'POST':
            return _Response(200, self.rendered)
        if (endpoint == 'repos/owner/repo/issues/99/comments'
                and method == 'POST'):
            comment = {
                'id': self.next_comment_id,
                'user': {'login': BOT},
                'body': payload['body'],
            }
            self.next_comment_id += 1
            self.comments.append(comment)
            return _Response(201, comment)
        match = re.fullmatch(
            r'repos/owner/repo/issues/comments/([0-9]+)', endpoint)
        if match and method == 'PATCH':
            comment_id = int(match.group(1))
            for comment in self.comments:
                if comment['id'] == comment_id:
                    comment['body'] = payload['body']
                    return _Response(200, comment)
            raise AssertionError(f'comment {comment_id} does not exist')
        match = re.fullmatch(
            r'repos/owner/repo/issues/([0-9]+)', endpoint)
        if match and method == 'GET':
            issue = self.issues.get(match.group(1))
            return _Response(200, issue) if issue is not None else _Response(
                404, None)
        raise AssertionError(f'unmodelled: {method} {endpoint} {payload!r}')

    def paginate(self, endpoint):
        self.calls.append(('GET', endpoint, None))
        if self.paginate_error is not None:
            raise RuntimeError(self.paginate_error)
        if self._failed('GET', endpoint):
            return _Response(500, None)
        if endpoint == 'repos/owner/repo/issues/99/comments':
            return _Response(200, self.comments)
        if endpoint == 'repos/owner/repo/issues/99/timeline':
            return _Response(200, self.timeline)
        raise AssertionError(f'unmodelled: GET {endpoint}')


class _RaceApi(FakeApi):
    def __init__(self, *, transition, trigger='markdown', number=1,
                 **kwargs):
        super().__init__(**kwargs)
        self.transition = transition
        self.trigger = trigger
        self.number = number
        self.pull_reads = 0

    def _transition(self):
        event = self.transition
        self.transition = None
        if event == 'merged':
            self.pull['merged'] = True
            return
        if event == 'reclosed':
            self.pull['state'] = 'closed'
            self.timeline.extend([
                {'event': 'reopened', 'actor': {'login': 'maintainer'}},
                _closed_event('maintainer'),
            ])
            return
        self.pull['state'] = 'closed' if event == 'closed' else 'open'
        self.timeline.append({
            'event': event, 'actor': {'login': 'maintainer'}})

    def request(self, method, endpoint, payload=None):
        if method == 'POST' and endpoint == 'markdown':
            if self.trigger == 'markdown' and self.transition is not None:
                self._transition()
        if method == 'GET' and endpoint.endswith('/pulls/99'):
            self.pull_reads += 1
            if (self.transition is not None
                    and self.trigger == 'pull-read'
                    and self.pull_reads == self.number):
                self._transition()
        response = super().request(method, endpoint, payload)
        if (self.transition is not None
                and self.trigger == 'after-write'
                and len(self.writes) == self.number
                and 200 <= response.status < 300):
            self._transition()
        return response


def _gate_module():
    path = ROOT / 'scripts' / 'ci' / 'pr_gate.py'
    if not path.is_file():
        return None
    return _util.load(path, 'scripts.ci.pr_gate')


def run_gate(api, body=None):
    gate = _gate_module()
    assert gate is not None, 'scripts/ci/pr_gate.py is not implemented'
    api.pull['body'] = body
    code = gate.run(api, 'owner/repo', '99', 'alice', TEMPLATE)
    return code, api.writes


def _pull(state='open', merged=False):
    return {'body': '', 'state': state, 'merged': merged}


def _api(*, state='open', merged=False, issues=None, **kwargs):
    if issues is None:
        issues = {'101': _issue('alice')}
    return FakeApi(
        pull=_pull(state, merged), issues=issues, **kwargs)


def _gate_comment(closed=False):
    lines = ['old gate message', MARKER]
    if closed:
        lines.append(CLOSED_MARKER)
    return {'id': 7, 'user': {'login': BOT}, 'body': '\n'.join(lines)}


def _inline_marker_comment():
    return {
        'id': 71,
        'user': {'login': BOT},
        'body': ('unrelated automation documentation\n'
                 '`<!-- pr-gate --> <!-- pr-gate: closed -->`'),
    }


def _closed_event(actor=BOT):
    return {'event': 'closed', 'actor': {'login': actor}}


def _execute(api, body):
    output = io.StringIO()
    error = io.StringIO()
    with (contextlib.redirect_stdout(output),
          contextlib.redirect_stderr(error)):
        code, writes = run_gate(api, body)
    return code, writes, output.getvalue(), error.getvalue()


def _execute_without_runtime_escape(api, body):
    try:
        return _execute(api, body)
    except RuntimeError as error:
        raise AssertionError('paginate error escaped run') from error


def _write_sequence(writes):
    return [(method, endpoint) for method, endpoint, _payload in writes]


def _issue_gets(api):
    return [call for call in api.calls if re.fullmatch(
        r'repos/owner/repo/issues/[0-9]+', call[1])]


def _write_gh_stub(tmp):
    directory = Path(tmp) / 'bin'
    directory.mkdir()
    if os.name == 'nt':
        script = directory / 'gh.py'
        script.write_text(GH_STUB, encoding='utf-8')
        command = directory / 'gh.bat'
        command.write_text(
            '@python "%~dp0gh.py" %*\n', encoding='utf-8')
    else:
        command = directory / 'gh'
        command.write_text(GH_STUB, encoding='utf-8')
        command.chmod(0o755)
    return directory, command


def _run_script(tmp, fixtures):
    directory, _command = _write_gh_stub(tmp)
    fixtures_path = Path(tmp) / 'fixtures.json'
    fixtures_path.write_text(json.dumps(fixtures), encoding='utf-8')
    calls_path = Path(tmp) / 'calls.jsonl'
    calls_path.write_text('', encoding='utf-8')
    environment = {
        **os.environ,
        'PATH': f'{directory}{os.pathsep}{os.environ["PATH"]}',
        'GH_TOKEN': 'stub',
        'REPO': 'owner/repo',
        'PR': '99',
        'ACTOR': 'alice',
        'STUB_FIXTURES': str(fixtures_path),
        'STUB_CALLS': str(calls_path),
    }
    result = subprocess.run(
        [sys.executable, 'scripts/ci/pr_gate.py'], cwd=ROOT,
        env=environment, capture_output=True, text=True, timeout=30)
    calls = [json.loads(line) for line in calls_path.read_text(
        encoding='utf-8').splitlines()]
    return result, calls


def _recorded_writes(calls):
    writes = []
    for call in calls:
        argv = call['argv']
        if '-X' not in argv:
            continue
        method = argv[argv.index('-X') + 1]
        endpoint = argv[argv.index('-X') + 2]
        if method != 'GET' and endpoint != 'markdown':
            writes.append((method, endpoint, call['input']))
    return writes


def _comment_page_fields(calls):
    fields = []
    for call in calls:
        argv = call['argv']
        if len(argv) < 5 or not argv[4].endswith('/comments'):
            continue
        fields.extend(
            argv[index] for index in range(1, len(argv))
            if argv[index - 1] == '-f' and argv[index].startswith('page='))
    return fields


def _assert_script_error(tmp, fixtures, message):
    result, calls = _run_script(tmp, fixtures)
    assert result.returncode == 1, (result.stdout, result.stderr, calls)
    assert _recorded_writes(calls) == []
    assert result.stderr == f'pr gate failed: {message}\n'


def _capture(call):
    output = io.StringIO()
    error = io.StringIO()
    with (contextlib.redirect_stdout(output),
          contextlib.redirect_stderr(error)):
        code = call()
    return code, output.getvalue(), error.getvalue()


def _runtime_error(call):
    try:
        call()
    except RuntimeError as error:
        return str(error)
    raise AssertionError('RuntimeError was not raised')


class _PaginationApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def _request(self, method, endpoint, payload=None, fields=()):
        response = self.responses[len(self.calls)]
        self.calls.append((method, endpoint, payload, fields))
        return response


CLI_FOOTER_BODY = '\n## Footer\n\nGenerated by GPT-6 Astra (implementer)\n'
CLI_FOOTER_HTML = (
    '\n<h2 dir="auto">Footer</h2>\n'
    '<p dir="auto">Generated by GPT-6 Astra (implementer)</p>')


def _script_fixtures(**extra):
    return {
        'pull': {'body': _valid_body() + CLI_FOOTER_BODY,
                 'state': 'open', 'merged': False},
        'comments': [],
        'timeline': [],
        'rendered': _valid_html() + CLI_FOOTER_HTML,
        'issues': {'101': _issue('alice')},
        **extra,
    }


def _assert_script_runs_through_gh_on_path(tmp):
    fixtures = _script_fixtures()
    result, calls = _run_script(tmp, fixtures)
    assert result.returncode == 0, (result.stdout, result.stderr, calls)
    assert _recorded_writes(calls) == []
    forbidden = set('&|<>^')
    assert all(
        forbidden.isdisjoint(argument) for call in calls
        for argument in call['argv']), calls

    body = _valid_body('none') + CLI_FOOTER_BODY
    fixtures = {
        **fixtures,
        'pull': {'body': body, 'state': 'open', 'merged': False},
        'rendered': _valid_html(references=_text_html('none')) + CLI_FOOTER_HTML,
        'issues': {},
    }
    other = Path(tmp) / 'closable'
    other.mkdir()
    result, calls = _run_script(other, fixtures)
    assert result.returncode == 0, (result.stdout, result.stderr, calls)
    assert all(
        forbidden.isdisjoint(argument) for call in calls
        for argument in call['argv']), calls
    writes = _recorded_writes(calls)
    assert [(method, endpoint) for method, endpoint, _payload in writes] == [
        ('POST', 'repos/owner/repo/issues/99/comments'),
        ('PATCH', 'repos/owner/repo/pulls/99')]
    comment = writes[0][2]['body']
    assert writes[1][2] == {'state': 'closed'}
    assert any(
        call['input'] == {
            'text': body, 'mode': 'gfm', 'context': 'owner/repo'}
        for call in calls)
    assert all(comment not in argument for call in calls
               for argument in call['argv'])


def _markdown_code_spans(text):
    runs = list(re.finditer(r'`+', text))
    spans = []
    index = 0
    while index < len(runs):
        opener = runs[index]
        close = next((candidate for candidate in runs[index + 1:]
                      if len(candidate.group()) == len(opener.group())), None)
        if close is None:
            break
        spans.append((opener.start(), close.end()))
        index = runs.index(close) + 1
    return spans
