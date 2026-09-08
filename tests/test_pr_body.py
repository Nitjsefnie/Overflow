#!/usr/bin/env python3
"""Rendered pull-request body analysis."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util  # noqa: E402
from _parser_guard import (  # noqa: E402
    assigned_state_names, base_state_names)
from _prfootnotes import (  # noqa: E402
    FOOTNOTE_HTML, FOOTNOTE_LAYOUT, FOOTNOTE_REFERENCED,
    FOOTNOTE_REFERENCED_BY_ROW, FOOTNOTE_SECTIONS, NESTED_HEADING_HTML,
    NESTED_HEADING_NOTE, RELATED)
from _prgate import (  # noqa: E402
    GITHUB_FOOTNOTE_HTML, GITHUB_HTML, PR_BODY,
    TEMPLATE, _html_body, _issue_html, _layout_body, _text_html,
    _valid_body, _valid_html,
)


REPOSITORY = 'Nitjsefnie-Harness-Commons/daedalus'


def test_parser_splits_sections_and_collects_links_and_issues(tmp):
    del tmp
    sections = PR_BODY.parse_rendered(_valid_html(), 'owner/repo').sections
    assert [section.key for section in sections] == [
        'summary', RELATED, 'changes', 'testing']
    related = sections[1]
    assert related.issues == (101,)
    assert related.links == (
        'https://github.com/owner/repo/issues/101',)


def test_parser_accepts_heading_depth_emphasis_and_colon(tmp):
    del tmp
    rendered = (
        '<h3><em>Related Issues and Pull Requests:</em></h3>\n'
        f'<p>Fixes {_issue_html(101)}</p>')
    sections = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    assert [section.key for section in sections] == [RELATED]


def test_the_injected_footnote_label_opens_no_section(tmp):
    """GitHub's own label opens no section of its own.

    An author cannot reach this branch: /markdown prefixes every
    author-supplied id with user-content-, so a bare footnote-label
    is the generator's.
    """
    del tmp
    sections = PR_BODY.parse_rendered(
        GITHUB_FOOTNOTE_HTML, REPOSITORY).sections
    assert [section.key for section in sections] == [
        'summary', RELATED, 'changes', 'testing']
    assert PR_BODY.referenced_issues(sections) == [101]


def test_content_inside_the_label_region_reaches_no_section(tmp):
    """The element holding the label is attributed to no section.

    The region it opens ends where that element ends, so the section
    it interrupts keeps the text, links and images that are its own.
    A footnote definition renders inside that element, and an image or
    a link there belongs to the definition rather than to the section.
    """
    del tmp
    rendered = (
        '<h2>Testing</h2>\n<section data-footnotes="" class="footnotes">'
        '<h2 id="footnote-label" class="sr-only">Footnotes</h2>\n'
        '<p><img src="diagram.png" alt=""> <a href="notes.md">x</a>'
        '</p>\n</section>')
    sections = PR_BODY.parse_rendered(rendered, REPOSITORY).sections
    assert [section.key for section in sections] == ['testing']
    assert sections[0].links == ()
    assert 'Section "Testing" is empty.' in PR_BODY.layout_errors(
        sections, TEMPLATE)


def test_parser_rejects_unusable_html(tmp):
    del tmp
    unusable = (
        'plain text',
        '&amp;',
        '&#65;',
        '<p',
        '<h2>Summary</h2><p>text',
        '<h2>Summary</h2><h2',
        '<p>a</b>',
        # Pins the refusal, not its reason: with the self-closing guard
        # removed the unfinished-element guard refuses this too, so the
        # reason is pinned in tests/test_pr_body_elements.py instead.
        '<h2>Summary</h2><div/>',
    )
    accepted = []
    for rendered in unusable:
        try:
            PR_BODY.parse_rendered(rendered, 'owner/repo')
        except ValueError as error:
            assert 'rendered HTML' in str(error), error
        else:
            accepted.append(rendered)
    assert accepted == [], accepted


def test_a_content_free_rendering_is_a_body_with_no_sections(tmp):
    """GitHub pads its rendering of a body with no content, so an answer
    with neither elements nor non-whitespace text is usable; one
    carrying text but no markup is not rendered HTML.
    """
    del tmp
    for rendered in ('', '\n', '\n' * 9, ' \t\r\n'):
        answer = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert answer == PR_BODY.Body((), (), ()), repr(rendered)
    try:
        PR_BODY.parse_rendered('plain text', 'owner/repo')
    except ValueError as error:
        assert str(error) == 'input is not usable rendered HTML', error
    else:
        raise AssertionError('text without markup was accepted')


def test_parser_reports_a_nested_heading_as_a_layout_note(tmp):
    """A nested heading is a verdict the gate reports, not a refusal.

    GitHub closes an open heading before another heading of its own,
    but not before a raw element, so a heading line wrapping one that
    holds a heading renders as a genuine nesting. The parser admits
    the body, records the note once however many headings nest, and
    reads the sections the rendering leaves it; the gate folds the
    notes into its refusal reasons.
    """
    del tmp
    keys = {
        'div_in_heading': ['summary', RELATED, 'changes', 'testing inner'],
        'two_headings_in_div': ['summary', RELATED, 'changes', 'testing ab'],
        'raw_section_in_heading': [
            'summary', RELATED, 'changes', 'testing inner'],
        'footnote_section_in_heading': ['summary', RELATED, 'changes',
                                        'testing'],
        'forged_label_in_heading': ['summary', RELATED, 'changes',
                                    'testing'],
        'empty_heading_in_div': ['summary', RELATED, 'changes', 'testing'],
    }
    for name, rendered in NESTED_HEADING_HTML.items():
        body = PR_BODY.parse_rendered(rendered, REPOSITORY)
        assert body.notes == (NESTED_HEADING_NOTE,), name
        assert [section.key for section in body.sections] == keys[name], name


def test_parser_rejects_unfinished_heading(tmp):
    del tmp
    try:
        PR_BODY.parse_rendered('<h2>Summary', 'owner/repo')
    except ValueError as error:
        assert 'unfinished heading' in str(error), error
    else:
        raise AssertionError('unfinished heading was accepted')


def test_parser_rejects_an_unfinished_label_region(tmp):
    """A region the input never closes is refused, and named.

    GitHub closes every element it emits, so no rendered body reaches
    this; it keeps the module's answer to a structure it cannot finish
    reading a refusal rather than a partial reading. The label holds
    no heading open and the element holding it is refused as the
    element it is, so neither shape borrows the heading's wording.
    """
    del tmp
    unfinished = {
        '<h2>Summary</h2><h2 id="footnote-label">Footnotes':
            'rendered HTML contains an unfinished region',
        '<div><h2 id="footnote-label">Footnotes</h2>':
            'rendered HTML contains an unfinished element',
    }
    for rendered, expected in unfinished.items():
        try:
            PR_BODY.parse_rendered(rendered, 'owner/repo')
        except ValueError as error:
            assert str(error) == expected, (rendered, error)
        else:
            raise AssertionError(f'{rendered} was accepted')


def test_parser_rejects_malformed_repositories(tmp):
    del tmp
    rendered = '<h2>Summary</h2><p>text</p>'
    accepted = []
    for repository in ('owner', 'a/b/c', '/'):
        try:
            PR_BODY.parse_rendered(rendered, repository)
        except ValueError as error:
            assert 'owner/name' in str(error), error
        else:
            accepted.append(repository)
    assert accepted == [], accepted


def test_visible_reference_fixtures_remain_visible(tmp):
    del tmp
    names = (
        'nested_list',
        'paragraph_continuation',
        'escaped_backticks',
        'angle_prose',
        'undefined_reference',
        'malformed_inline',
    )
    failures = []
    for name in names:
        sections = PR_BODY.parse_rendered(
            _html_body(('Related Issues and Pull Requests',
                        GITHUB_HTML[name])),
            REPOSITORY).sections
        found = PR_BODY.referenced_issues(sections)
        if found != [101]:
            failures.append((name, found))
    assert failures == [], failures


def test_nontext_reference_fixtures_remain_hidden(tmp):
    del tmp
    names = (
        'inline_code',
        'fenced_code',
        'indented_code',
        'html_attribute',
        'balanced_destination',
        'quoted_attribute',
        'multiline_attribute',
        'image_destination',
    )
    failures = []
    for name in names:
        sections = PR_BODY.parse_rendered(
            _html_body(('Related Issues and Pull Requests',
                        GITHUB_HTML[name])),
            REPOSITORY).sections
        found = PR_BODY.referenced_issues(sections)
        if found:
            failures.append((name, found))
        if name == 'html_attribute':
            assert sections[0].links == ('#101',)
    assert failures == [], failures


def test_parser_ignores_named_anchor_without_href(tmp):
    del tmp
    rendered = _html_body(
        ('Related Issues and Pull Requests', GITHUB_HTML['named_anchor']))
    sections = PR_BODY.parse_rendered(rendered, REPOSITORY).sections
    assert sections[0].links == ()
    assert PR_BODY.referenced_issues(sections) == []


def test_numeric_character_references_contribute_visible_text(tmp):
    del tmp
    rendered = _html_body(
        ('Summary', '<p>&#35;101 &#x23;101</p>'))
    sections = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    assert sections[0].text.strip() == '#101 #101'


def test_bare_section_text_is_not_duplicated_at_close(tmp):
    del tmp
    rendered = _html_body(('Summary', 'hello world'))
    sections = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    assert sections[0].text == '\nhello world', repr(sections[0].text)


def test_parser_state_names_do_not_collide_with_the_base(tmp):
    del tmp
    collisions = assigned_state_names() & base_state_names()
    assert not collisions, (
        '_RenderedBodyParser assigns state the parser base owns: '
        f'{sorted(collisions)}')


def test_related_helpers_return_empty_without_related_section(tmp):
    del tmp
    sections = PR_BODY.parse_rendered(
        _html_body(('Summary', '<p>text</p>')), 'owner/repo').sections
    actual = (
        PR_BODY.referenced_issues(sections),
        PR_BODY.related_links(sections),
    )
    assert actual == ([], []), actual


def test_issue_number_language(tmp):
    del tmp
    too_wide = '/owner/repo/issues/' + ('9' * 20)
    www_host = 'www.' + 'github.com'
    credentialed = 'user@' + 'github.com'
    cases = (
        ('https://github.com/owner/repo/issues/101', 101),
        ('HTTPS://GITHUB.COM/Owner/Repo/issues/101', 101),
        ('https://github.com:443/owner/repo/issues/101', 101),
        ('http://github.com:80/owner/repo/issues/101', 101),
        ('//github.com/owner/repo/issues/101', 101),
        ('/owner/repo/issues/101', 101),
        ('https://github.com/owner/repo/issues/101?x=1#c', 101),
        (f'https://{www_host}/owner/repo/issues/101', None),
        ('https://github.com:8443/owner/repo/issues/101', None),
        ('https://github.com:notaport/owner/repo/issues/101', None),
        (f'https://{credentialed}/owner/repo/issues/101', None),
        ('owner/repo/issues/101', None),
        ('//owner/repo/issues/101', None),
        ('/other/repo/issues/101', None),
        ('/owner/repo/pull/101', None),
        ('/owner/repo/issues/0', None),
        (too_wide, None),
        ('ftp://github.com/owner/repo/issues/101', None),
        ('', None),
    )
    failures = []
    for href, expected in cases:
        found = PR_BODY.issue_number(href, 'owner/repo')
        if found != expected:
            failures.append((href, found, expected))
    assert failures == [], failures


def _layout_errors(rendered, template=TEMPLATE):
    sections = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    return PR_BODY.layout_errors(sections, template)


def test_layout_accepts_required_sections_without_optional_footer(tmp):
    del tmp
    assert _layout_errors(_valid_html()) == []


def test_layout_reports_each_missing_or_empty_section(tmp):
    del tmp
    rendered = _html_body(
        ('Related Issues and Pull Requests', f'Fixes {_issue_html(91)}'),
        ('Changes', ''),
        ('Testing', _text_html('Ran the suite.')),
        ('Breaking Changes', ''))
    errors = _layout_errors(rendered)
    assert 'Required section "Summary" is missing.' in errors
    assert 'Section "Changes" is empty.' in errors
    assert 'Section "Breaking Changes" is empty.' in errors


def test_layout_rejects_constructs_that_render_as_empty(tmp):
    del tmp
    for name in (
            'empty_list', 'empty_ordered', 'empty_quote',
            'link_definition'):
        rendered = _valid_html(changes=GITHUB_HTML[name])
        assert 'Section "Changes" is empty.' in _layout_errors(
            rendered), name


def test_layout_treats_an_image_as_section_content(tmp):
    del tmp
    images = (
        '<p dir="auto"><img src="diagram.png" '
        'alt="migration diagram"></p>',
        '<p dir="auto"><img src="diagram.png"></p>',
        '<p dir="auto"><img src="diagram.png"/></p>',
    )
    for image in images:
        rendered = _valid_html() + _html_body(('Breaking Changes', image))
        assert _layout_errors(rendered) == [], image


def test_layout_treats_invisible_text_as_empty(tmp):
    del tmp
    invisible = (
        '\u200b', '\ufe0f', '\u180b', '\u180c', '\u180d', '\u180f',
        '\u034f', '\u115f', '\u1160', '\u3164', '\uffa0', '\u2800')
    for character in invisible:
        rendered = _valid_html(
            changes=f'<p dir="auto">{character}</p>')
        assert 'Section "Changes" is empty.' in _layout_errors(
            rendered), f'U+{ord(character):04X}'


def test_layout_treats_empty_or_invisible_images_as_empty(tmp):
    del tmp
    for image in (
            GITHUB_HTML['empty_image'],
            GITHUB_HTML['zero_size_image']):
        rendered = _valid_html(changes=image)
        assert 'Section "Changes" is empty.' in _layout_errors(
            rendered), image


def test_layout_parses_html_image_dimension_values(tmp):
    del tmp
    cases = (
        ('width="00"', True),
        ('height="000"', True),
        ('width=" 0"', True),
        ('width="0px"', True),
        ('width="0.5"', False),
        ('height="0.5"', False),
        ('width="0.0"', True),
        ('width=".5"', False),
        ('width="0."', True),
        ('width="00.000x"', True),
        ('width="10"', False),
        ('width="01"', False),
        ('width="+0"', False),
        ('width="-0"', False),
        ('width=""', False),
    )
    failures = []
    for attribute, expected_empty in cases:
        image = f'<p><img src="diagram.png" alt="" {attribute}></p>'
        errors = _layout_errors(_valid_html(changes=image))
        empty = 'Section "Changes" is empty.' in errors
        if empty != expected_empty:
            failures.append((attribute, empty, expected_empty))
    assert failures == [], failures


def test_layout_rejects_a_template_heading_without_a_rule(tmp):
    del tmp
    template = '## Summary\n\n## Changes\n<!-- required: explain -->\n'
    rendered = _html_body(
        ('Summary', _text_html('Summary.')),
        ('Changes', _text_html('Change.')))
    try:
        _layout_errors(rendered, template)
    except ValueError as error:
        assert 'Summary' in str(error), error
        assert 'instruction comment' in str(error), error
    else:
        raise AssertionError('a section without a template rule was ignored')


def test_layout_reports_unknown_duplicate_and_out_of_order_sections(tmp):
    del tmp
    rendered = _html_body(
        ('Summary', _text_html('First.')),
        ('Changes', _text_html('Too early.')),
        ('Notes', _text_html('Unknown.')),
        ('Summary', _text_html('Again.')),
        ('Related Issues and Pull Requests', f'Fixes {_issue_html(91)}'),
        ('Testing', _text_html('Ran the suite.')))
    errors = _layout_errors(rendered)
    assert 'Section `Notes` is not defined by the template.' in errors
    assert 'Section "Summary" appears more than once.' in errors
    assert ('Section "Related Issues and Pull Requests" is out of order.'
            in errors)


def test_a_footnote_section_splits_like_any_other_section(tmp):
    del tmp
    assert {name for name, _ in FOOTNOTE_SECTIONS} == set(FOOTNOTE_HTML)
    failures = []
    for name, expected in FOOTNOTE_SECTIONS:
        sections = PR_BODY.parse_rendered(
            FOOTNOTE_HTML[name], REPOSITORY).sections
        found = tuple(section.key for section in sections)
        referenced = PR_BODY.referenced_issues(sections)
        wanted = FOOTNOTE_REFERENCED_BY_ROW.get(name, FOOTNOTE_REFERENCED)
        if (found, referenced) != (expected, wanted):
            failures.append((name, found, referenced))
    assert failures == [], failures


def test_a_keyword_free_footnote_reference_reaches_no_section(tmp):
    """Both channels' answers for a reference no keyword governs.

    The reference is collected from the rendered document, so nothing
    hides it; it simply belongs to no section, because the element
    holding the label it follows is attributed to none.
    """
    del tmp
    for name in ('footnote_definition_bare', 'footnote_in_related'):
        body = PR_BODY.parse_rendered(FOOTNOTE_HTML[name], REPOSITORY)
        assert PR_BODY.closing_issues(body) == [101], name
        assert PR_BODY.referenced_issues(body.sections) == [101], name
        collected = [
            number for section in body.sections
            for number in section.issues]
        assert collected == [101], name


def test_layout_judges_a_footnote_body_by_the_template_alone(tmp):
    del tmp
    assert {name for name, _ in FOOTNOTE_LAYOUT} == set(FOOTNOTE_HTML)
    failures = []
    for name, expected in FOOTNOTE_LAYOUT:
        sections = PR_BODY.parse_rendered(
            FOOTNOTE_HTML[name], REPOSITORY).sections
        found = PR_BODY.layout_errors(sections, TEMPLATE)
        if found != expected:
            failures.append((name, found, expected))
    assert failures == [], failures


def test_layout_counts_rendered_code_as_content(tmp):
    del tmp
    rendered = _valid_html(changes=GITHUB_HTML['inline_code'])
    assert _layout_errors(rendered) == []


def test_layout_ignores_heading_shaped_text_in_raw_html(tmp):
    del tmp
    rendered = _valid_html(changes=GITHUB_HTML['kbd_block'])
    assert _layout_errors(rendered) == []


def test_unknown_section_reasons_escape_adversarial_names(tmp):
    del tmp
    name = 'x`#1'
    rendered = _valid_html() + _html_body(
        (name, _text_html('Unknown.')))
    errors = _layout_errors(rendered)
    reason = 'Section ``x`#1`` is not defined by the template.'
    assert reason in errors
    assert '#1' not in reason.replace('``x`#1``', '')


def test_code_span_pads_backtick_boundaries_and_whitespace(tmp):
    del tmp
    cases = (
        ('`start', '`` `start ``'),
        ('end`', '`` end` ``'),
        ('   ', '`     `'),
    )
    failures = [
        (text, PR_BODY.code_span(text), expected)
        for text, expected in cases
        if PR_BODY.code_span(text) != expected
    ]
    assert failures == [], failures


def test_retains_instruction_comment(tmp):
    del tmp
    comment = re.search(r'<!--.*?-->', TEMPLATE, re.DOTALL).group(0)
    assert PR_BODY.retains_instruction_comment(comment, TEMPLATE)
    crlf = comment.replace('\n', '\r\n')
    assert PR_BODY.retains_instruction_comment(crlf, TEMPLATE)
    assert not PR_BODY.retains_instruction_comment(_valid_body(), TEMPLATE)
    prose = comment.removeprefix('<!--').removesuffix('-->')
    assert not PR_BODY.retains_instruction_comment(prose, TEMPLATE)


def _may_reference(source, related_html):
    sections = PR_BODY.parse_rendered(
        _valid_html(references=related_html), 'owner/repo').sections
    return PR_BODY.related_may_reference(source, sections, TEMPLATE)


def test_related_may_reference_accepts_reference_shapes(tmp):
    del tmp
    anchor = '<p dir="auto"><a href="#101">reference</a></p>'
    www_host = 'www.' + 'github.com'
    enterprise_host = 'ghe.' + 'example'
    cases = (
        ('hash', '#101', anchor),
        ('uppercase-gh', 'GH-101', anchor),
        ('lowercase-gh', 'gh-7', anchor),
        ('repository-hash', 'owner/repo#101', anchor),
        ('absolute-issue',
         'https://github.com/owner/repo/issues/101', anchor),
        ('default-port',
         'https://github.com:443/owner/repo/issues/101', anchor),
        ('www-http',
         f'http://{www_host}/owner/repo/issues/101', anchor),
        ('root-relative', '/owner/repo/issues/101', anchor),
        ('markdown-link', '[x](/owner/repo/issues/101)', anchor),
        ('reference-definition',
         '[x]: https://github.com/owner/repo/issues/101', anchor),
        ('angle-autolink',
         '<https://github.com/owner/repo/pull/5>', anchor),
        ('enterprise-host',
         f'https://{enterprise_host}/o/r/issues/5', anchor),
        ('percent-encoding',
         'https://github.com/owner/repo/%69ssues/101', anchor),
        ('numeric-entity', '&#35;101', _text_html('#101')),
        ('named-entity', '&num;101', _text_html('#101')),
        ('code-span', '`#101`', GITHUB_HTML['inline_code']),
        ('fenced-code', '```\n#101\n```', GITHUB_HTML['fenced_code']),
    )
    failures = []
    for name, spelling, rendered in cases:
        source = _valid_body(references=spelling)
        sections = PR_BODY.parse_rendered(
            _valid_html(references=rendered), 'owner/repo').sections
        full = PR_BODY.related_may_reference(source, sections, TEMPLATE)
        raw = PR_BODY.related_may_reference(source, [], TEMPLATE)
        if not full or not raw:
            failures.append((name, full, raw))
    assert failures == [], failures


def test_related_may_reference_accepts_decorated_related_heading(tmp):
    del tmp
    source = _valid_body().replace(
        '## Related Issues and Pull Requests',
        '### **Related Issues and Pull Requests:**')
    assert PR_BODY.related_may_reference(source, [], TEMPLATE)


def test_related_may_reference_rejects_missing_related_reference(tmp):
    del tmp
    cases = (
        ('prose', _valid_body('see the tracker'),
         _text_html('see the tracker')),
        ('summary-only', _layout_body(
            ('Summary', 'Mentions #101.'),
            ('Related Issues and Pull Requests', 'see the tracker'),
            ('Changes', '- One change'),
            ('Testing', 'Ran the suite.')),
         _text_html('see the tracker')),
        ('empty', '', _text_html('see the tracker')),
    )
    failures = []
    for name, source, rendered in cases:
        found = _may_reference(source, rendered)
        if found:
            failures.append(name)
    source = _layout_body(
        ('Summary', 'Mentions #101.'),
        ('Changes', '- One change'),
        ('Testing', 'Ran the suite.'))
    if _may_reference(source, _text_html('see the tracker')):
        failures.append('no-related-heading')
    assert failures == [], failures


def test_related_may_reference_stops_at_template_heading(tmp):
    del tmp
    source = _layout_body(
        ('Summary', 'One sentence.'),
        ('Related Issues and Pull Requests', 'see the tracker'),
        ('Changes', '#101'),
        ('Testing', 'Ran the suite.'))
    assert not _may_reference(source, _text_html('see the tracker'))


def test_related_may_reference_keeps_non_template_heading_in_region(tmp):
    del tmp
    source = _layout_body(
        ('Summary', 'One sentence.'),
        ('Related Issues and Pull Requests', 'see the tracker'),
        ('Notes', '#101'),
        ('Changes', '- One change'),
        ('Testing', 'Ran the suite.'))
    assert PR_BODY.related_may_reference(source, [], TEMPLATE)


def test_related_may_reference_accepts_rendered_link_alone(tmp):
    del tmp
    rendered = _valid_html(
        references='<p dir="auto"><a href="#101">reference</a></p>')
    sections = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    assert PR_BODY.related_may_reference('nothing', sections, TEMPLATE)


def main():
    return _util.runner(
        _util.collect(globals()), tmp_prefix='prbody_')


if __name__ == '__main__':
    raise SystemExit(main())
