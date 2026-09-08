#!/usr/bin/env python3
"""Read GitHub-rendered pull-request HTML for admission checks.

closing_issues takes a whole Body because its subject is body-wide; the
other helpers that consume a parse result take sections.
"""
import re
from html import unescape
from html.parser import HTMLParser
from typing import NamedTuple
from unicodedata import category
from urllib.parse import urlsplit

if __package__:
    # pylint: disable-next=relative-beyond-top-level
    from .pr_body_closing import _gap_closing
else:
    from pr_body_closing import _gap_closing


RELATED = 'related issues and pull requests'
_NESTED_HEADING_NOTE = (
    'A heading is nested inside another heading; remove the raw HTML '
    'element from that heading line.')
_BACKTICKS = re.compile(r'`+')
_HEADING_LINE = re.compile(
    r'^[ \t]{0,3}#{1,6}[ \t]+(?P<text>.+?)[ \t]*#*[ \t]*$',
    re.MULTILINE)
_HTML_DIMENSION = re.compile(
    r'[ \t\n\f\r]*(?P<integer>[0-9]+)(?:\.(?P<fraction>[0-9]*))?')
_REFERENCE_SHAPE = re.compile(
    r'#[0-9]|gh-[0-9]|issues/|pull/|://|%|&#|&num', re.IGNORECASE)
_TEMPLATE_HEADING = re.compile(
    r'^##[ \t]+(?P<text>.+?)[ \t]*$', re.MULTILINE)
_TEMPLATE_COMMENT = re.compile(r'<!--.*?-->', re.DOTALL)
_TEMPLATE_TAG = re.compile(
    r'<!--\s*(?P<tag>required|conditional|optional)\b', re.IGNORECASE)
_HEADING_TAGS = frozenset(f'h{depth}' for depth in range(1, 7))
_FOOTNOTE_LABEL = 'footnote-label'
_VOID_TAGS = frozenset((
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
    'meta', 'param', 'source', 'track', 'wbr',
))
_MAX_ISSUE_DIGITS = 19
_BLOCK_TAGS = frozenset((
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'li',
    'ol', 'p', 'pre', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
    'hr'))
_INVISIBLE_CHARACTERS = frozenset((
    '\u034f', '\u115f', '\u1160', '\u180b', '\u180c', '\u180d',
    '\u180f', '\u2800', '\u3164', '\uffa0',
))


class Section(NamedTuple):
    name: str
    key: str
    text: str
    links: tuple[str, ...]
    issues: tuple[int, ...]


class Body(NamedTuple):
    sections: tuple[Section, ...]
    closing: tuple[int, ...]
    notes: tuple[str, ...]


class Rule(NamedTuple):
    name: str
    tag: str
    index: int


def _heading_text(text):
    text = ' '.join(text.split())
    if text.endswith(':'):
        text = text[:-1].rstrip()
    return text


def _repository_parts(repository):
    parts = repository.strip('/').split('/')
    if len(parts) != 2 or not all(parts):
        raise ValueError('repository must have the form owner/name')
    return tuple(part.casefold() for part in parts)


def issue_number(href, repository):
    if not href:
        return None
    try:
        target = urlsplit(href)
        port = target.port
    except ValueError:
        return None
    if target.netloc:
        scheme = target.scheme.casefold()
        default_port = {'': 443, 'http': 80, 'https': 443}.get(scheme)
        if (default_port is None
                or (target.hostname or '').casefold() != 'github.com'
                or target.username is not None or target.password is not None
                or port not in (None, default_port)):
            return None
    elif (target.scheme or not href.startswith('/')
          or href.startswith('//')):
        return None
    parts = target.path.strip('/').split('/')
    if len(parts) != 4 or parts[2].casefold() != 'issues':
        return None
    if tuple(part.casefold() for part in parts[:2]) != _repository_parts(
            repository):
        return None
    digits = parts[3]
    if (not digits.isascii() or not digits.isdecimal()
            or len(digits) > _MAX_ISSUE_DIGITS):
        return None
    number = int(digits)
    return number or None


def _zero_html_dimension(value):
    match = _HTML_DIMENSION.match(value)
    if match is None:
        return False
    digits = match.group('integer') + (match.group('fraction') or '')
    return not digits.strip('0')


class _RenderedBodyParser(HTMLParser):
    def __init__(self, repository):
        super().__init__(convert_charrefs=False)
        _repository_parts(repository)
        self.repository = repository
        self.sections = []
        self.closing = []
        self.notes = []
        self.saw_element = False
        self.saw_content = False
        self._open_tags = []
        self._heading_tag = None
        self._heading_parts = []
        self._name = None
        self._key = None
        self._text = []
        self._links = []
        self._issues = []
        self._gap = []
        self._run_start = 0
        self._anchor_depth = 0
        self._previous_closing = False
        self._label_depth = None
        self._region_depth = None

    def handle_starttag(self, tag, attrs):
        self.saw_element = True
        tag = tag.casefold()
        if tag not in _VOID_TAGS:
            self._open_tags.append(tag)
        attributes = {
            name.casefold(): value or '' for name, value in attrs}
        # Every element boundary ends the run a keyword must sit in, so
        # a character in another element is never adjacent to it. The
        # reference's own anchor ends the run too, so its decision reads
        # the run as it stood when that anchor opened.
        run = self._current_run()
        self._end_run()
        if tag in _HEADING_TAGS:
            if attributes.get('id') == _FOOTNOTE_LABEL:
                # GitHub prefixes an author's id with user-content-, so
                # a bare one is its own injected footnote label. Its
                # element is a region no section owns, left only at
                # that element's end: a heading inside opens no section.
                self._label_depth = len(self._open_tags)
                self._region_depth = self._label_depth - 1
                self._break_closing_list()
                return
            if self._heading_tag is not None:
                # GitHub leaves a heading line's raw element open until
                # the line's own heading closes, so an author can nest
                # one heading inside another. That is a verdict the gate
                # reports rather than a shape it cannot read, and the
                # gate's reasons are the distinct problems an author has
                # to fix.
                if _NESTED_HEADING_NOTE not in self.notes:
                    self.notes.append(_NESTED_HEADING_NOTE)
                return
            if self._region_depth is not None:
                return
            self._finish_section()
            self._heading_tag = tag
            self._heading_parts = []
            self._break_closing_list()
            return
        if tag == 'img':
            self._record_text(attributes.get('alt', ''))
            zero_size = any(
                _zero_html_dimension(attributes.get(name, ''))
                for name in ('width', 'height'))
            if (self._heading_tag is None and self._key is not None
                    and self._region_depth is None
                    and attributes.get('src') and not zero_size):
                self._text.append('\ufffc')
            return
        if tag in _BLOCK_TAGS:
            self._break_closing_list()
        if tag == 'a':
            self._anchor_depth += 1
        if tag != 'a':
            return
        destinations = [
            value for name, value in attrs if name.casefold() == 'href']
        if not destinations:
            return
        href = destinations[0]
        # Only the closing channel reads the whole body; a link or an issue
        # reference belongs to the section it sits in, and a preamble or
        # heading anchor is in none.
        inside = (self._heading_tag is None and self._key is not None
                  and self._region_depth is None)
        if href and inside:
            self._links.append(href)
        number = issue_number(href, self.repository)
        if number is None:
            return
        closing = _gap_closing(
            run, ''.join(self._gap), self._previous_closing)
        if inside:
            self._issues.append(number)
        if closing:
            self.closing.append(number)
        self._previous_closing = closing
        self._gap = []

    def handle_startendtag(self, tag, attrs):
        tag = tag.casefold()
        if tag not in _VOID_TAGS:
            raise ValueError(
                'rendered HTML contains a self-closing content element')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if not self._open_tags or self._open_tags[-1] != tag:
            raise ValueError(
                'rendered HTML contains mismatched element boundaries')
        depth = len(self._open_tags)
        self._open_tags.pop()
        if tag == 'a' and self._anchor_depth:
            self._anchor_depth -= 1
        if tag in _BLOCK_TAGS:
            self._break_closing_list()
        self._end_run()
        if depth == self._label_depth:
            # Taken ahead of the author heading's close below: a heading
            # holding the label is an h2 too, and closes after it.
            self._label_depth = None
            return
        if depth == self._region_depth:
            self._region_depth = None
        if tag != self._heading_tag:
            return
        name = _heading_text(''.join(self._heading_parts))
        self._name = name
        self._key = name.casefold()
        self._text = []
        self._links = []
        self._issues = []
        self._heading_tag = None
        self._heading_parts = []
        self._break_closing_list()

    def handle_data(self, data):
        self.saw_content = self.saw_content or bool(data.strip())
        self._record_text(data)
        self._record_pending(data)

    def handle_entityref(self, name):
        data = unescape(f'&{name};')
        self.saw_content = self.saw_content or bool(data.strip())
        self._record_text(data)
        self._record_pending(data)

    def handle_charref(self, name):
        data = unescape(f'&#{name};')
        self.saw_content = self.saw_content or bool(data.strip())
        self._record_text(data)
        self._record_pending(data)

    def _record_text(self, data):
        if self._region_depth is not None:
            return
        if self._heading_tag is not None:
            self._heading_parts.append(data)
        elif self._key is not None:
            self._text.append(data)

    def _record_pending(self, data):
        if not self._anchor_depth and self._label_depth is None:
            self._gap.append(data)

    def _current_run(self):
        return ''.join(self._gap[self._run_start:])

    def _end_run(self):
        self._run_start = len(self._gap)

    def _break_closing_list(self):
        # A block or heading boundary breaks a closing-keyword list: a
        # keyword on one side governs no anchor on the other, so the gap
        # text and the running list state both restart across it.
        self._gap = []
        self._run_start = 0
        self._previous_closing = False

    def finish(self):
        # GitHub renders a body carrying no content to the empty
        # string or to newline padding, so an answer with neither
        # elements nor non-whitespace text is that rendering rather
        # than an unusable one.
        if self.saw_content and not self.saw_element:
            raise ValueError('input is not usable rendered HTML')
        if self.rawdata:
            raise ValueError('rendered HTML is structurally incomplete')
        super().close()
        if self._heading_tag is not None:
            raise ValueError('rendered HTML contains an unfinished heading')
        if any(tag not in _HEADING_TAGS for tag in self._open_tags):
            raise ValueError('rendered HTML contains an unfinished element')
        if self._region_depth is not None:
            raise ValueError('rendered HTML contains an unfinished region')
        self._finish_section()

    def _finish_section(self):
        if self._key is None or self._name is None:
            return
        self.sections.append(Section(
            self._name, self._key, ''.join(self._text),
            tuple(self._links), tuple(self._issues)))
        self._name = None
        self._key = None
        self._text = []
        self._links = []
        self._issues = []


def parse_rendered(rendered, repository):
    parser = _RenderedBodyParser(repository)
    parser.feed(rendered or '')
    parser.finish()
    return Body(
        tuple(parser.sections), tuple(parser.closing), tuple(parser.notes))


def closing_issues(body):
    """Ordered issue references whose text carries a closing keyword."""
    found = []
    seen = set()
    for number in body.closing:
        if number not in seen:
            seen.add(number)
            found.append(number)
    return found


def referenced_issues(sections):
    section = next(
        (item for item in sections if item.key == RELATED), None)
    if section is None:
        return []
    found = []
    seen = set()
    for number in section.issues:
        if number not in seen:
            seen.add(number)
            found.append(number)
    return found


def code_span(text):
    runs = [len(run) for run in _BACKTICKS.findall(text)]
    fence = '`' * (max(runs, default=0) + 1)
    if text.startswith('`') or text.endswith('`') or not text.strip():
        text = f' {text} '
    return f'{fence}{text}{fence}'


def template_rules(template):
    headings = list(_TEMPLATE_HEADING.finditer(template))
    rules = {}
    for index, heading in enumerate(headings):
        name = _heading_text(heading.group('text'))
        end = (headings[index + 1].start()
               if index + 1 < len(headings) else len(template))
        tag = _TEMPLATE_TAG.search(template[heading.end():end])
        if tag is None:
            raise ValueError(
                f'template section "{name}" has no instruction comment')
        rules[name.casefold()] = Rule(name, tag.group('tag').casefold(), index)
    return rules


def _has_visible_text(text):
    for char in text:
        if char.isspace() or char in _INVISIBLE_CHARACTERS:
            continue
        if category(char) in ('Cc', 'Cf', 'Cs'):
            continue
        if ('\ufe00' <= char <= '\ufe0f'
                or '\U000e0100' <= char <= '\U000e01ef'):
            continue
        return True
    return False


def layout_errors(sections, template):
    rules = template_rules(template)
    errors = []
    seen = set()
    last_index = -1
    for section in sections:
        rule = rules.get(section.key)
        if rule is None:
            errors.append(
                f'Section {code_span(section.name)} is not defined by '
                'the template.')
            continue
        if section.key in seen:
            errors.append(f'Section "{rule.name}" appears more than once.')
        seen.add(section.key)
        if rule.index < last_index:
            errors.append(f'Section "{rule.name}" is out of order.')
        else:
            last_index = rule.index
        if not _has_visible_text(section.text):
            errors.append(f'Section "{rule.name}" is empty.')
    for key, rule in rules.items():
        if rule.tag == 'required' and key not in seen:
            errors.append(f'Required section "{rule.name}" is missing.')
    return errors


def retains_instruction_comment(source, template):
    source = source.replace('\r\n', '\n').replace('\r', '\n')
    template = template.replace('\r\n', '\n').replace('\r', '\n')
    return any(
        match.group(0) in source
        for match in _TEMPLATE_COMMENT.finditer(template))


def related_links(sections):
    section = next(
        (item for item in sections if item.key == RELATED), None)
    return list(section.links) if section is not None else []


def _heading_name(text):
    return _heading_text(text.strip('*_~` ')).casefold()


def _related_regions(source, names):
    source = source.replace('\r\n', '\n').replace('\r', '\n')
    headings = list(_HEADING_LINE.finditer(source))
    regions = []
    for index, heading in enumerate(headings):
        if _heading_name(heading.group('text')) != RELATED:
            continue
        end = len(source)
        for later in headings[index + 1:]:
            if _heading_name(later.group('text')) in names:
                end = later.start()
                break
        regions.append(source[heading.end():end])
    return regions


def related_may_reference(source, sections, template):
    names = set(template_rules(template))
    if any(_REFERENCE_SHAPE.search(region)
           for region in _related_regions(source or '', names)):
        return True
    return bool(related_links(sections))
