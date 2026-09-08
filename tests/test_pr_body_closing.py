#!/usr/bin/env python3
"""Closing-reference collection in a rendered pull-request body.

Relocated from tests/test_pr_body.py so that suite stays under its size
ceiling; the closing channel is one grammar and reads as one suite.
"""
import html
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util  # noqa: E402
from _prfootnotes import FOOTNOTE_HTML  # noqa: E402
from _prgate import (  # noqa: E402
    GITHUB_FOOTNOTE_HTML, GITHUB_HTML, GITHUB_ISSUE_101, GITHUB_ISSUE_104,
    PR_BODY, PR_BODY_CLOSING, _html_body, _issue_html, _text_html,
    _valid_html,
)


REPOSITORY = 'Nitjsefnie-Harness-Commons/daedalus'
_ISSUE_URL = 'https://github.com/owner/repo/issues/101'
RELATED = 'related issues and pull requests'

# Captured from GitHub's /markdown endpoint in GFM mode with
# Nitjsefnie-Harness-Commons/daedalus as the context, for the
# source "Fixes #104\n\n## Fixes #105\n\nRan the suite.".
GITHUB_OUTSIDE_SECTIONS_HTML = (
    f'<p dir="auto">Fixes {GITHUB_ISSUE_104}</p>\n'
    '<h2 dir="auto">Fixes <a class="issue-link js-issue-link" '
    'data-error-text="Failed to load title" data-id="5232282547" '
    'data-permission-text="Title is private" '
    'data-url="https://github.com/Nitjsefnie-Harness-Commons/daedalus/'
    'issues/105" data-hovercard-type="issue" '
    'data-hovercard-url="/Nitjsefnie-Harness-Commons/daedalus/issues/105/'
    'hovercard" href="https://github.com/Nitjsefnie-Harness-Commons/'
    'daedalus/issues/105">#105</a></h2>\n'
    '<p dir="auto">Ran the suite.</p>')

GITHUB_FOOTNOTE_CLOSING_HTML = (
    f'<h2 dir="auto">Summary</h2>\n<p dir="auto">One sentence.</p>\n<h2 '
    f'dir="auto">Related Issues and Pull Requests</h2>\n<p dir="auto">Fixes '
    f'{GITHUB_ISSUE_101}</p>\n<h2 dir="auto">Changes</h2>\n<ul dir="auto">\n'
    f'<li>One change<sup><a '
    f'href="#user-content-fn-1-d80c8cefc4d4d0c0cc35d32ce0250e0e" '
    f'id="user-content-fnref-1-d80c8cefc4d4d0c0cc35d32ce0250e0e" '
    f'data-footnote-ref="" aria-describedby="footnote-label">1</a></sup></li>'
    f'\n</ul>\n<h2 dir="auto">Testing</h2>\n<p dir="auto">Ran the suite.</p>'
    f'\n<section data-footnotes="" class="footnotes"><h2 id="footnote-label" '
    f'class="sr-only" dir="auto">Footnotes</h2>\n<ol dir="auto">\n<li '
    f'id="user-content-fn-1-d80c8cefc4d4d0c0cc35d32ce0250e0e">\n<p '
    f'dir="auto">Fixes {GITHUB_ISSUE_104} <a '
    f'href="#user-content-fnref-1-d80c8cefc4d4d0c0cc35d32ce0250e0e" '
    f'data-footnote-backref="" aria-label="Back to reference 1" '
    f'class="data-footnote-backref">↩</a></p>\n</li>\n</ol>\n</section>')

GITHUB_SECTION_CLOSING_HTML = (
    f'<h2 dir="auto">Summary</h2>\n<p dir="auto">One sentence.</p>\n<h2 '
    f'dir="auto">Related Issues and Pull Requests</h2>\n<p dir="auto">Fixes '
    f'{GITHUB_ISSUE_101}</p>\n<h2 dir="auto">Changes</h2>\n<ul dir="auto">\n'
    f'<li>One change</li>\n<li>Fixes {GITHUB_ISSUE_104}</li>\n</ul>\n<h2 '
    f'dir="auto">Testing</h2>\n<p dir="auto">Ran the suite.</p>')

# The answer closing_issues gives for each captured rendering in
# tests/_prgate.py that carries an anchor; its control pins that set.
# escaped_backticks closes because a backtick is not a word character,
# which is the boundary GitHub itself was measured on.
CAPTURED_CLOSING = (
    ('angle_prose', []),
    ('balanced_destination', []),
    ('empty_image', []),
    ('escaped_backticks', [101]),
    ('html_attribute', []),
    ('image_destination', []),
    ('malformed_inline', []),
    ('multiline_attribute', []),
    ('named_anchor', []),
    ('nested_list', [101]),
    ('paragraph_continuation', [101]),
    ('quoted_attribute', []),
    ('undefined_reference', []),
    ('zero_size_image', []),
)


# One gap text per spelling GitHub was measured on, placed before an
# issue anchor in a rendered paragraph. A closing table without its
# inert twin cannot see over-acceptance, so each half pins the other.
LEFT_CLOSING = (
    'Fixes ', '(Fixes ', '[Fixes ', '"Fixes ', "'Fixes ", '\u2014Fixes ',
    '\u00abFixes ', 'hot-fixes ', '/fixes ', 'x -fixes ',
    '\U0001f527fixes ', ')Fixes ', '`Fixes ',
)
LEFT_INERT = (
    'unfixes ', '2fixes ', 'a_fixes ', '\u00e9fixes ', '\u4feefixes ',
    '\u00b2fixes ', '\u00bdfixes ', '\u2167fixes ',
)
SEPARATOR_CLOSING = (
    'Fixes ', 'Fixes  ', 'Fixes\t', 'Fixes: ', 'Fixes : ', 'Fixes:  ')
SEPARATOR_INERT = (
    'Fixes:: ', 'Fixes, ', 'Fixes; ', 'Fixes. ', 'Fixes! ', 'Fixes) ',
    'Fixes - ', 'Fixes -> ', 'Fixes... ', 'Fixes \u2014 ', 'Fixes` ',
    'fixing ',
)
# Inert on GitHub, closing here. The no-separator row is reachable
# although `Fixes#N` renders no anchor: `Fixes[#N](<the issue's URL>)`
# renders the keyword and the anchor with no character between them.
WIDER_THAN_GITHUB = ('Fixes', 'Fixes:', 'Fixes\n', 'Fixes\u00a0')

# Folding is required, not extra width: `fixeſ #N` closes on GitHub, so
# an ASCII-only or fold-free match would refuse a spelling it acts on.
# `FİXES ` is the one measured spelling folding admits and GitHub does
# not; a ligature and the fullwidth letters fold on neither side.
FOLDED_CLOSING = ('FIXES ', 'fixe\u017f ', 'F\u0130XES ')
FOLDED_INERT = ('\ufb01xes ', '\uff26\uff29\uff38\uff25\uff33 ')

# A character reference is decoded before the boundary rule sees it, on
# both sides: GitHub measured `a&#95;fixes #N` inert too. Each row turns
# over when _record_pending is dropped from the handler delivering it,
# so the two handlers are pinned in both directions.
CHARACTER_REFERENCE_GAPS = (
    ('&#95;fixes ', []),
    ('a&#38;fixes ', [101]),
    ('&eacute;fixes ', []),
    ('a&amp;fixes ', [101]),
)


def _gap_html(gap):
    escaped = html.escape(gap, quote=False)
    return f'<p dir="auto">{escaped}{_issue_html(101)}</p>'


def _gap_answers(gaps):
    answers = []
    for gap in gaps:
        body = PR_BODY.parse_rendered(
            _valid_html(references=_gap_html(gap)), 'owner/repo')
        answers.append((gap, PR_BODY.closing_issues(body)))
    return answers


# Fifth round: a word character in a DIFFERENT inline node must not hide
# the keyword, since GitHub never sees the two adjacent. Each row is
# paired with its mirror from the second round, where the keyword itself
# is on the far side of the boundary and stays inert. The elements are
# ones GitHub's rendering keeps, and the last two are outside every
# emphasis-shaped tag list, so a deny list cannot pass this table.
NODE_BOUNDARY_CLOSING = (
    '<em>a</em>fixes ',
    '<strong>a</strong>fixes ',
    '<code class="notranslate">x</code>fixes ',
    '<del>a</del>fixes ',
    'a<span>b</span>fixes ',
    'x <kbd>a</kbd>fixes ',
)
NODE_BOUNDARY_INERT = (
    'a<strong>fixes</strong> ',
    '2<em>fixes</em> ',
    'a<code class="notranslate">fixes</code> ',
)


def _markup_answers(markups):
    answers = []
    for markup in markups:
        rendered = _valid_html(
            references=f'<p dir="auto">{markup}{_issue_html(101)}</p>')
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        answers.append((markup, PR_BODY.closing_issues(body)))
    return answers


def _assert_gaps(closing, inert):
    assert _gap_answers(closing) == [(gap, [101]) for gap in closing]
    assert _gap_answers(inert) == [(gap, []) for gap in inert]


def test_closing_issues_reads_the_governing_keyword(tmp):
    del tmp
    rendered = _valid_html(references=(
        f'References {_issue_html(101)}, Fixes {_issue_html(102)}'))
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.referenced_issues(body.sections) == [101, 102]
    assert PR_BODY.closing_issues(body) == [102]


def test_closing_issues_includes_keyword_list_continuation(tmp):
    del tmp
    cases = (
        (f'Fixes {_issue_html(101)}, {_issue_html(102)}', [101, 102]),
        (f'Fixes {_issue_html(101)} and {_issue_html(102)}', [101, 102]),
        (f'Fixes {_issue_html(101)}, {_issue_html(102)}, and '
         f'{_issue_html(103)}', [101, 102, 103]),
        (f'Fixes {_issue_html(101)}. References {_issue_html(102)}',
         [101]),
        (f'Fixes: {_issue_html(101)}', [101]),
        (f'resolved {_issue_html(101)}', [101]),
        (f'Closes {_issue_html(101)}', [101]),
        (f'closed {_issue_html(101)}', [101]),
        (f'fix {_issue_html(101)}', [101]),
        (f'fixed {_issue_html(101)}', [101]),
        (f'Resolve {_issue_html(101)}', [101]),
        (f'References {_issue_html(101)}, Fixes {_issue_html(102)}, '
         f'{_issue_html(103)}', [102, 103]),
        (f'Fixes #{101}', []),
        (f'Fixes::: {_issue_html(101)}', []),
        ('<table dir="auto"><tbody><tr><td>Fixes '
         f'{_issue_html(101)}</td><td>'
         f'{_issue_html(102)}</td></tr></tbody></table>', [101]),
        ('<p dir="auto">Fixes <code class="notranslate">x</code>'
         f'{_issue_html(101)}</p>', []),
        ('<ul dir="auto">\n<li>Fixes '
         f'{_issue_html(101)}\n<ul dir="auto">\n<li>'
         f'{_issue_html(102)}</li>\n</ul>\n</li>\n</ul>', [101]),
        (f'Fixes {_issue_html(101)}\n<hr>\n{_issue_html(102)}', [101]),
        (f'Fixes <a href="{_ISSUE_URL}"><code class="notranslate">#101'
         f'</code></a>, {_issue_html(102)}', [101, 102]),
    )
    for references, closing in cases:
        rendered = _valid_html(references=references)
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert PR_BODY.closing_issues(body) == closing, references


def test_every_closing_keyword_spelling_closes(tmp):
    del tmp
    spellings = (
        'close', 'closes', 'closed', 'fix', 'fixes', 'fixed',
        'resolve', 'resolves', 'resolved')
    assert PR_BODY_CLOSING._CLOSING_KEYWORDS == frozenset(spellings)
    for keyword in spellings:
        rendered = _valid_html(references=f'{keyword} {_issue_html(101)}')
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert PR_BODY.closing_issues(body) == [101], keyword


def test_closing_issues_checks_every_section(tmp):
    del tmp
    summary = f'<p dir="auto">Also fixes {_issue_html(104)}.</p>'
    rendered = _valid_html(
        references=f'References {_issue_html(101)}').replace(
            _text_html('One sentence.'), summary)
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.referenced_issues(body.sections) == [101]
    assert PR_BODY.closing_issues(body) == [104]


def test_closing_keyword_does_not_cross_a_section_boundary(tmp):
    del tmp
    rendered = _valid_html(
        references=_issue_html(101)).replace(
            _text_html('One sentence.'), _text_html('One sentence. Fixes'))
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.closing_issues(body) == []


def test_closing_list_does_not_cross_a_section_boundary(tmp):
    del tmp
    summary = f'<p dir="auto">Fixes {_issue_html(101)}</p>'
    rendered = _valid_html(
        references=_issue_html(104)).replace(
            _text_html('One sentence.'), summary)
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.closing_issues(body) == [101]


def test_section_boundary_resets_without_block_tags(tmp):
    del tmp
    rendered = (
        '<h2 dir="auto">Summary</h2>\n'
        'Fixes\n'
        '<h2 dir="auto">Related Issues and Pull Requests</h2>\n'
        f'{_issue_html(104)}\n')
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.closing_issues(body) == []
    rendered = (
        '<h2 dir="auto">Summary</h2>\n'
        f'Fixes {_issue_html(101)}\n'
        '<h2 dir="auto">Related Issues and Pull Requests</h2>\n'
        f'{_issue_html(104)}\n')
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.closing_issues(body) == [101]


def test_block_boundary_ends_a_closing_keyword_list(tmp):
    del tmp
    cases = (
        (f'<ul dir="auto">\n<li>Fixes {_issue_html(101)}</li>\n'
         f'<li>{_issue_html(102)}</li>\n</ul>', [101]),
        (f'<p dir="auto">Fixes {_issue_html(101)}</p>\n'
         f'<p dir="auto">{_issue_html(102)}</p>', [101]),
        (f'<p dir="auto">Fixes {_issue_html(101)}</p>\n<hr>\n'
         f'<p dir="auto">{_issue_html(102)}</p>', [101]),
        (f'<p dir="auto">Fixes</p>\n<p dir="auto">{_issue_html(101)}</p>',
         []),
        (f'<p dir="auto">Fixes {_issue_html(101)}, '
         f'{_issue_html(102)}</p>', [101, 102]),
    )
    for references, closing in cases:
        rendered = _valid_html(references=references)
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert PR_BODY.closing_issues(body) == closing, references


def test_keyword_inside_fenced_code_governs_no_anchor(tmp):
    del tmp
    rendered = _valid_html(references=(
        '<pre class="notranslate"><code class="notranslate">Fixes\n'
        '</code></pre>\n'
        f'<p dir="auto">{_issue_html(102)}</p>'))
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.closing_issues(body) == []


def test_preamble_closing_reference_is_collected(tmp):
    del tmp
    rendered = (
        f'<p dir="auto">Fixes {_issue_html(104)}</p>\n' + _valid_html())
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert PR_BODY.closing_issues(body) == [104, 101]
    assert PR_BODY.referenced_issues(body.sections) == [101]
    assert [section.key for section in body.sections] == [
        'summary', RELATED, 'changes', 'testing']


def test_heading_closing_reference_is_collected(tmp):
    """A heading's closing reference is body-wide, not section-level.

    The empty ``issues`` and ``links`` record the absence of a
    section-level leak, which the heading-close reset enforces as much as
    the ``inside`` guard does, so neither of them pins the other.
    """
    del tmp
    body = PR_BODY.parse_rendered(
        GITHUB_OUTSIDE_SECTIONS_HTML, REPOSITORY)
    assert PR_BODY.closing_issues(body) == [104, 105]
    assert [section.key for section in body.sections] == ['fixes #105']
    assert body.sections[0].issues == ()
    assert body.sections[0].links == ()


def test_closing_issues_reports_a_repeated_number_once(tmp):
    del tmp
    summary = f'<p dir="auto">Fixes {_issue_html(101)}.</p>'
    rendered = _valid_html().replace(
        _text_html('One sentence.'), summary)
    body = PR_BODY.parse_rendered(rendered, 'owner/repo')
    assert body.closing == (101, 101)
    assert PR_BODY.closing_issues(body) == [101]


def test_captured_renderings_pin_the_closing_answer(tmp):
    del tmp
    assert {name for name, _ in CAPTURED_CLOSING} == {
        name for name, markup in GITHUB_HTML.items() if '<a ' in markup}
    failures = []
    for name, expected in CAPTURED_CLOSING:
        body = PR_BODY.parse_rendered(
            _html_body(('Related Issues and Pull Requests',
                        GITHUB_HTML[name])),
            REPOSITORY)
        found = PR_BODY.closing_issues(body)
        if found != expected:
            failures.append((name, found, expected))
    # Issue 585's leg for this fixture; its footnote holds no issue anchor.
    body = PR_BODY.parse_rendered(GITHUB_FOOTNOTE_HTML, REPOSITORY)
    found = PR_BODY.closing_issues(body)
    if found != [101]:
        failures.append(('footnote_html', found, [101]))
    assert failures == [], failures


def test_a_footnote_definition_closes_what_a_section_would(tmp):
    """Pin a footnote definition against its ordinary-section twin.

    The two captures differ only in where ``Fixes #104`` sits: a footnote
    definition in the first, an ordinary Changes item in the second. Both
    answer the same, because the rendered document is read as one and a
    footnote definition is rendered content like any other.
    """
    del tmp
    footnote = PR_BODY.parse_rendered(
        GITHUB_FOOTNOTE_CLOSING_HTML, REPOSITORY)
    assert PR_BODY.closing_issues(footnote) == [101, 104]
    section = PR_BODY.parse_rendered(
        GITHUB_SECTION_CLOSING_HTML, REPOSITORY)
    assert PR_BODY.closing_issues(section) == [101, 104]


# Four spellings were merged live against a scratch repository, one
# throwaway issue each, and GitHub closed on all four: a footnote
# definition, a hand-written data-footnotes wrapper, a bare div, and a
# details element. Issue 554's thread records them. The rows here are
# those four's consistent extrapolation, not merges of their own.
# no_dataattr and plain_div are the neighbours nothing ever suppressed,
# so they are the controls: their answer is the one the rest must reach.
FOOTNOTE_CLOSING = (
    ('footnote_definition_closing', [101, 104]),
    ('raw_section', [101, 104]),
    ('no_class', [101, 104]),
    ('own_heading', [101, 104]),
    ('no_dataattr', [101, 104]),
    ('plain_div', [101, 104]),
    ('forged_label_in_section', [101, 104]),
    ('label_no_footnote', [101, 104]),
    ('author_footnotes_heading', [101, 104]),
    ('heading_wrapped_ref', [101, 104]),
    ('two_sections', [101, 104, 105]),
    ('footnote_definition_bare', [101]),
    ('footnote_in_related', [101]),
    ('empty_testing_with_footnote', [101]),
    ('heading_wrapped', [101]),
    ('forged_label', [101]),
    ('id_only', [101]),
    ('class_only', [101]),
    ('id_upper_attr', [101]),
    ('wrapper_then_text', [101]),
    ('related_wrapper_then_ref', [101]),
    ('heading_keyword_across_wrapper', [101, 104]),
    ('definition_heading', [101]),
    ('definition_heading_text', [101]),
    ('two_definitions', [101]),
    ('wrapper_heading_then_resume', [101]),
    ('definition_empty_heading_list', [101, 104]),
    ('wrapper_div_list', [101, 104]),
)


def test_a_footnote_section_closes_what_github_closes(tmp):
    """A rendered footnote section hides no closing reference.

    The marker GitHub's generator writes is the marker /markdown echoes
    back from an author's own ``<section data-footnotes>``, normalised
    into the full spelling, so no attribute on the element separates
    generated content from written content. The heading GitHub injects
    into it is the half an author cannot forge, and it governs section
    boundaries only; this channel reads the whole document either way.
    The bare and in-related rows are the negative controls: a reference
    under no keyword still closes nothing.

    heading_keyword_across_wrapper kills the label's list break only
    while _record_pending withholds the label's own text. No rendering
    GitHub emits distinguishes that guard, so dropping it moves no
    answer here - and that silence is not evidence it is redundant:
    with the guard gone this row stops catching the break's removal.
    """
    del tmp
    assert {name for name, _ in FOOTNOTE_CLOSING} == set(FOOTNOTE_HTML)
    failures = []
    for name, expected in FOOTNOTE_CLOSING:
        body = PR_BODY.parse_rendered(FOOTNOTE_HTML[name], REPOSITORY)
        found = PR_BODY.closing_issues(body)
        if found != expected:
            failures.append((name, found, expected))
    assert failures == [], failures


# A heading carries text of its own, and that text lands in the gap the
# next anchor reads. Each boundary case therefore uses a heading whose
# text cannot stand in for the boundary: an empty one, or one holding
# nothing but the anchor.
def test_preamble_keyword_does_not_govern_a_section_anchor(tmp):
    del tmp
    cases = (
        ('Fixes\n', []),
        (f'Fixes {_issue_html(101)}\n', [101]),
    )
    for preamble, expected in cases:
        rendered = (
            preamble
            + '<h2 dir="auto"></h2>\n'
            + f'{_issue_html(104)}\n')
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert PR_BODY.closing_issues(body) == expected, preamble


def test_heading_keyword_does_not_govern_a_paragraph_anchor(tmp):
    del tmp
    cases = (
        ('Fixes', []),
        (f'Fixes {_issue_html(101)}', [101]),
    )
    for heading, expected in cases:
        rendered = (
            f'<h2 dir="auto">{heading}</h2>\n'
            f'{_issue_html(104)}\n')
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert PR_BODY.closing_issues(body) == expected, heading


def test_paragraph_keyword_does_not_govern_a_heading_anchor(tmp):
    del tmp
    cases = (
        ('Fixes\n', []),
        (f'Fixes {_issue_html(101)}\n', [101]),
    )
    for content, expected in cases:
        rendered = (
            '<h2 dir="auto">Summary</h2>\n'
            + content
            + f'<h2 dir="auto">{_issue_html(104)}</h2>\n')
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        assert PR_BODY.closing_issues(body) == expected, content


def test_only_a_non_word_character_may_precede_the_keyword(tmp):
    del tmp
    _assert_gaps(LEFT_CLOSING, LEFT_INERT)


def test_the_separator_takes_one_colon_and_no_other_punctuation(tmp):
    del tmp
    _assert_gaps(SEPARATOR_CLOSING, SEPARATOR_INERT)


def test_a_word_character_in_another_node_does_not_hide_it(tmp):
    del tmp
    assert _markup_answers(NODE_BOUNDARY_CLOSING) == [
        (markup, [101]) for markup in NODE_BOUNDARY_CLOSING]
    assert _markup_answers(NODE_BOUNDARY_INERT) == [
        (markup, []) for markup in NODE_BOUNDARY_INERT]


def test_case_folding_is_required_not_merely_extra_width(tmp):
    del tmp
    _assert_gaps(FOLDED_CLOSING, FOLDED_INERT)


def test_recognition_stays_wider_than_github_by_choice(tmp):
    """Shapes this closes that GitHub does not act on.

    None of them turns on an element boundary. The separators are
    whitespace or punctuation GitHub declines rather than a node --
    the newline row is formatting whitespace, not the soft break,
    which renders a break element and is refused with the agreements.
    The last two are the keyword list, and the first is a line whose
    first character opens a raw tag, which GitHub does not scan at all
    while this has no notion of where a line began.
    """
    del tmp
    assert _gap_answers(WIDER_THAN_GITHUB) == [
        (gap, [101]) for gap in WIDER_THAN_GITHUB]
    cases = (
        (f'<p dir="auto"><span>a</span>fixes {_issue_html(101)}</p>',
         [101]),
        (f'Fixes {_issue_html(101)}, {_issue_html(102)}', [101, 102]),
        (f'Fixes {_issue_html(101)} and {_issue_html(102)}', [101, 102]),
    )
    for references, closing in cases:
        body = PR_BODY.parse_rendered(
            _valid_html(references=references), 'owner/repo')
        assert PR_BODY.closing_issues(body) == closing, references


def test_a_character_reference_reaches_the_boundary_rule(tmp):
    del tmp
    answers = []
    for gap, _closing in CHARACTER_REFERENCE_GAPS:
        rendered = _valid_html(
            references=f'<p dir="auto">{gap}{_issue_html(101)}</p>')
        body = PR_BODY.parse_rendered(rendered, 'owner/repo')
        answers.append((gap, PR_BODY.closing_issues(body)))
    assert answers == list(CHARACTER_REFERENCE_GAPS)


def test_only_the_list_separator_carries_a_keyword_onward(tmp):
    del tmp
    cases = (
        (f'Fixes {_issue_html(101)} &amp; {_issue_html(102)}', [101, 102]),
        (f'Fixes {_issue_html(101)}; {_issue_html(102)}', [101]),
        (f'Fixes {_issue_html(101)}. {_issue_html(102)}', [101]),
        (f'Fixes {_issue_html(101)} or {_issue_html(102)}', [101]),
        # Both gaps are measured shapes: two explicit issue links render
        # adjacent, and `[#101](u)and #102` renders the bare `and ` the
        # separator carries onward. Neither gap opens with a space, so
        # both flip when the separator's leading `*` tightens to `+`.
        (f'Fixes {_issue_html(101)}{_issue_html(102)}', [101, 102]),
        (f'Fixes {_issue_html(101)}and {_issue_html(102)}', [101, 102]),
    )
    for references, closing in cases:
        body = PR_BODY.parse_rendered(
            _valid_html(references=references), 'owner/repo')
        assert PR_BODY.closing_issues(body) == closing, references


def test_structural_placements_close_as_github_measures_them(tmp):
    del tmp
    anchor = _issue_html(101)
    url = _ISSUE_URL
    # Two rows below drive endpoint captures recorded for issue 627: a
    # same-repository cross reference renders the anchor text #N, in an
    # anchor byte-identical to GITHUB_ISSUE_101, and an image, markdown
    # or raw, always renders inside a wrapper anchor, so a bare
    # <img> never sits between text and a reference. This suite's
    # owner/repo stands in for the repository path, and example.com for
    # the camo host, neither of which changes what the parser decides.
    same_repo = GITHUB_ISSUE_101.replace(
        'Nitjsefnie-Harness-Commons/daedalus', 'owner/repo')
    camo_image = (
        '<a target="_blank" rel="noopener noreferrer nofollow" '
        'href="https://example.com/'
        '5c7e6565b3f40cc1fe6675de6ac726f61e38c25df5a1846bf86904af7b14d030'
        '/68747470733a2f2f6578616d706c652e636f6d2f612e706e67">'
        '<img src="https://example.com/'
        '5c7e6565b3f40cc1fe6675de6ac726f61e38c25df5a1846bf86904af7b14d030'
        '/68747470733a2f2f6578616d706c652e636f6d2f612e706e67" alt="alt" '
        'data-canonical-src="https://example.com/a.png" '
        'style="max-width: 100%;"></a>')
    cases = (
        (f'<h3 dir="auto">Fixes {anchor}</h3>', [101]),
        (f'<ul dir="auto">\n<li>Fixes {anchor}</li>\n</ul>', [101]),
        (f'<blockquote>\n<p dir="auto">Fixes {anchor}</p>\n</blockquote>',
         [101]),
        ('<table dir="auto"><tbody><tr><td>Fixes '
         f'{anchor}</td></tr></tbody></table>', [101]),
        (f'<p dir="auto">Fixes <a href="{url}">GH-101</a></p>', [101]),
        (f'<p dir="auto">Fixes {same_repo}</p>', [101]),
        (f'<p dir="auto">Fixes {anchor}</p>', [101]),
        ('<p dir="auto"><a href="https://example.com" rel="nofollow">'
         f'Fixes</a> {anchor}</p>', []),
        (f'<p dir="auto"><a href="{url}">Fixes #101</a></p>', []),
        (f'<p dir="auto">a<strong>fixes</strong> {anchor}</p>', []),
        (f'<p dir="auto">2<em>fixes</em> {anchor}</p>', []),
        ('<p dir="auto">a<code class="notranslate">fixes</code> '
         f'{anchor}</p>', []),
        # Measured agreements, not deliberate width: the keyword falls
        # outside the run that ends at the reference.
        (f'<p dir="auto"><strong>Fixes</strong> {anchor}</p>', []),
        (f'<p dir="auto"><em>Fixes</em> {anchor}</p>', []),
        ('<p dir="auto"><code class="notranslate">Fixes</code> '
         f'{anchor}</p>', []),
        (f'<p dir="auto">Fixes<br>\n{anchor}</p>', []),
        (f'<p dir="auto">Fixes {camo_image} {same_repo}</p>', []),
        ('<p dir="auto">Fixes<sup><a href="#user-content-fn-1">1</a>'
         f'</sup> {anchor}</p>', []),
        ('<p dir="auto">Fixes <a href="https://example.com" '
         f'rel="nofollow">docs</a> {anchor}</p>', []),
        # An element wrapping the reference is a boundary like any
        # other, so the run never reaches it.
        (f'<p dir="auto">Fixes <strong>{anchor}</strong></p>', []),
        (f'<p dir="auto">Fixes <em>{anchor}</em></p>', []),
        (f'<p dir="auto">Fixes <del>{anchor}</del></p>', []),
    )
    for references, closing in cases:
        body = PR_BODY.parse_rendered(
            _valid_html(references=references), 'owner/repo')
        assert PR_BODY.closing_issues(body) == closing, references


def main():
    return _util.runner(
        _util.collect(globals()), tmp_prefix='prbodyclosing_')


if __name__ == '__main__':
    raise SystemExit(main())
