#!/usr/bin/env python3
"""Element shapes the rendered-body parser refuses, and image alt text.

What an element boundary refuses and what an element records are one
reading of the parser, and the repository caps a module's length, so
that reading grows here rather than in tests/test_pr_body.py. The
image tests left behind there read the marker a sourced image stands
for, not its alt.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util  # noqa: E402
from _prgate import (  # noqa: E402
    PR_BODY, TEMPLATE, _html_body, _issue_html, _text_html,
    _valid_html,
)


def test_parser_rejects_a_self_closing_content_element(tmp):
    """A non-void element written self-closing is refused as one.

    The closing tag is what makes this fixture bite: were the refusal
    removed, '<div/>' alone would be left open and refused as an
    unfinished element, so the test would stay green over a parser that
    had stopped reading the shape under test.
    """
    del tmp
    try:
        PR_BODY.parse_rendered('<div/></div>', 'owner/repo')
    except ValueError as error:
        assert str(error) == (
            'rendered HTML contains a self-closing content element'), error
    else:
        raise AssertionError('a self-closing content element was accepted')


def test_parser_rejects_an_end_tag_that_closes_nothing(tmp):
    """An end tag arriving with nothing open is refused, as a ValueError.

    The type is the point as much as the refusal: pr_gate converts a
    ValueError from the parser into a gate error, so a boundary read
    off an empty stack has to raise the same exception the tag-mismatch
    half raises rather than an IndexError the gate never converts.
    """
    del tmp
    try:
        PR_BODY.parse_rendered('</p>', 'owner/repo')
    except ValueError as error:
        assert str(error) == (
            'rendered HTML contains mismatched element boundaries'), error
    else:
        raise AssertionError('an end tag closing nothing was accepted')


def test_parser_records_no_text_for_an_image_without_alt(tmp):
    """An image carrying no alt contributes no text of its own.

    The section then holds only the line break the rendering puts
    before the paragraph and the object replacement marker a sourced
    image stands for, so any spelling the parser reached for in place
    of a missing alt would read here as section text.
    """
    del tmp
    rendered = _html_body(
        ('Changes', '<p dir="auto"><img src="diagram.png"></p>'))
    section, = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    assert section.text == '\n\ufffc', repr(section.text)


def test_parser_records_an_image_alt_text_as_section_content(tmp):
    """An image's alt text is the text its section records.

    The object replacement marker needs a source, so the alt text is
    all such an image gives the section.
    """
    del tmp
    with_alt = (
        '<p dir="auto"><a target="_blank" rel="noopener noreferrer" '
        'href=""><img src="" alt="migration diagram" '
        'style="max-width: 100%;"></a></p>')
    sections = PR_BODY.parse_rendered(
        _valid_html(changes=with_alt), 'owner/repo').sections
    assert 'migration diagram' in sections[2].text


def test_layout_reads_an_image_alt_text_as_a_heading_name(tmp):
    """An image in a heading names the section that heading opens."""
    del tmp
    rendered = _html_body(
        ('Summary', _text_html('One sentence.')),
        ('Related Issues and Pull Requests', f'Fixes {_issue_html(101)}'),
        ('Changes', '<ul dir="auto">\n<li>One change</li>\n</ul>'),
    ) + (
        '\n<h2 dir="auto"><a target="_blank" rel="noopener noreferrer" '
        'href="diagram.png"><img src="diagram.png" alt="Testing" '
        'style="max-width: 100%;"></a></h2>\n'
        '<p dir="auto">Ran the suite.</p>')
    sections = PR_BODY.parse_rendered(rendered, 'owner/repo').sections
    assert PR_BODY.layout_errors(sections, TEMPLATE) == []


def main():
    return _util.runner(
        _util.collect(globals()), tmp_prefix='prbodyelements_')


if __name__ == '__main__':
    raise SystemExit(main())
