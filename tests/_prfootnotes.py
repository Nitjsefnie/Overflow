#!/usr/bin/env python3
"""GitHub renderings of bodies carrying a footnote section, and answers.

Captured from GitHub's /markdown endpoint in GFM mode with
Nitjsefnie-Harness-Commons/daedalus as the context. They live here
rather than beside their assertions because the section suite and the
closing suite both read them, and neither has room for the set; the
section and layout answers each capture must reach live here with them.

Each key names what its Markdown source did:

- footnote_definition_closing  a `[^1]: Fixes #104` definition
- footnote_definition_bare     the same definition without a keyword
- raw_section                  an author-written footnote section
- footnote_in_related          a footnote reference in Related Issues
- empty_testing_with_footnote  a definition as Testing's only content
- no_class                     `<section data-footnotes>` alone
- no_dataattr                  `<section class="footnotes">` alone
- own_heading                  a heading inside a written footnote section
- plain_div                    the same content in a `<div>`
- heading_wrapped              an empty footnote section on a heading line
- heading_wrapped_ref          the same, holding a closing reference
- forged_label                 a heading spelling the label's id and class
- forged_label_in_section      that forgery inside a written section
- author_footnotes_heading     an author's own `## Footnotes` heading
- id_only                      the forgery carrying the id alone
- class_only                   the forgery carrying the class alone
- id_upper_attr                the forgery in upper-case attribute names
- two_sections                 a written section beside a definition
- label_no_footnote            the forgery ahead of a closing reference
- wrapper_then_text            a wrapper mid-section, prose after it
- related_wrapper_then_ref     a wrapper inside Related, reference after
- heading_keyword_across_wrapper  a heading-line keyword list broken by one
- definition_heading            a heading inside a footnote definition
- definition_heading_text       the same, with prose under the heading
- two_definitions               two definitions, the second after a block
- wrapper_heading_then_resume   a heading inside a wrapper, prose after it
- definition_empty_heading_list  an empty heading mid-list in a definition
- wrapper_div_list             a block start mid-list in a wrapper

NESTED_HEADING_HTML holds the captured renderings whose heading line
wraps a raw element holding another heading, with or without a
footnote section. The parser admits each and records the
nested-heading note once however many headings nest, which the gate
reports among its refusal reasons. empty_heading_in_div is the row
whose inner heading is empty and whose section carries text, so the
note is the only fault its body has.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _prgate import (  # noqa: E402
    GITHUB_ISSUE_101, GITHUB_ISSUE_104, PR_BODY)


# Captured from GitHub's /markdown endpoint in GFM mode with
# Nitjsefnie-Harness-Commons/daedalus as the context. It sits here
# rather than beside its 101 and 104 siblings in _prgate because the
# two fixtures naming issue 105 are both in this file.
GITHUB_ISSUE_105 = (
    '<a class="issue-link js-issue-link" data-error-text="Failed to load '
    'title" data-id="5232282547" data-permission-text="Title is private" '
    'data-url="https://github.com/Nitjsefnie-Harness-Commons/daedalus/issues'
    '/105" data-hovercard-type="issue" '
    'data-hovercard-url="/Nitjsefnie-Harness-Commons/daedalus/issues/105/hov'
    'ercard" '
    'href="https://github.com/Nitjsefnie-Harness-Commons/daedalus/issues/105'
    '">#105</a>')

_HEAD = (
    '<h2 dir="auto">Summary</h2>\n<p dir="auto">One sentence.</p>\n<h2 '
    'dir="auto">Related Issues and Pull Requests</h2>\n<p dir="auto">Fixes '
    f'{GITHUB_ISSUE_101}</p>\n<h2 dir="auto">Changes</h2>\n')

_PLAIN = (
    '<p dir="auto">One change</p>\n<h2 dir="auto">Testing</h2>\n<p dir="aut'
    'o">Ran the suite.</p>\n')

_RAN_IT = (
    '<p dir="auto">One change</p>\n<h2 dir="auto">Testing</h2>\n<p dir="aut'
    'o">Ran it.</p>\n')

_RAN_IT_REF = (
    '<p dir="auto">One change[^1]</p>\n<h2 dir="auto">Testing</h2>\n<p dir='
    '"auto">Ran it.</p>\n')

FOOTNOTE_HTML = {
    'footnote_definition_closing': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-abbab87'
        '6102f5c249269fa9f80e1bb3a" id="user-content-fnref-1-abbab876102f'
        '5c249269fa9f80e1bb3a" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup></p>\n<h2 dir="auto">Testing</h2>\n<p di'
        'r="auto">Ran the suite.</p>\n<section data-footnotes="" class="f'
        'ootnotes"><h2 id="footnote-label" class="sr-only" dir="auto">Foo'
        'tnotes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1-abbab876'
        '102f5c249269fa9f80e1bb3a">\n<p dir="auto">Fixes '
        f'{GITHUB_ISSUE_104} <a href="#user-content-fnref-1-abbab876102f5'
        'c249269fa9f80e1bb3a" data-footnote-backref="" aria-label="Back t'
        'o reference 1" class="data-footnote-backref">↩</a></p>\n</li>\n<'
        '/ol>\n</section>'),
    'footnote_definition_bare': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-6c7bc20'
        '0ca46d991d005e1f10ee86f2f" id="user-content-fnref-1-6c7bc200ca46'
        'd991d005e1f10ee86f2f" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup></p>\n<h2 dir="auto">Testing</h2>\n<p di'
        'r="auto">Ran the suite.</p>\n<section data-footnotes="" class="f'
        'ootnotes"><h2 id="footnote-label" class="sr-only" dir="auto">Foo'
        'tnotes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1-6c7bc200'
        'ca46d991d005e1f10ee86f2f">\n<p dir="auto">See '
        f'{GITHUB_ISSUE_104} <a href="#user-content-fnref-1-6c7bc200ca46d'
        '991d005e1f10ee86f2f" data-footnote-backref="" aria-label="Back t'
        'o reference 1" class="data-footnote-backref">↩</a></p>\n</li>\n<'
        '/ol>\n</section>'),
    'raw_section': (
        _HEAD
        + _PLAIN
        + '<section data-footnotes="" class="footnotes"><h2 id="footnote-la'
        'bel" class="sr-only" dir="auto">Footnotes</h2>\n<p dir="auto">Fi'
        f'xes {GITHUB_ISSUE_104}</p>\n</section>'),
    'footnote_in_related': (
        '<h2 dir="auto">Summary</h2>\n<p dir="auto">One sentence.</p>\n<h'
        '2 dir="auto">Related Issues and Pull Requests</h2>\n<p dir="auto'
        f'">Fixes {GITHUB_ISSUE_101}<sup><a href="#user-content-fn-1-956c'
        'fa16221a7f456af446179cc56569" id="user-content-fnref-1-956cfa162'
        '21a7f456af446179cc56569" data-footnote-ref="" aria-describedby="'
        'footnote-label">1</a></sup></p>\n<h2 dir="auto">Changes</h2>\n<p'
        ' dir="auto">One change</p>\n<h2 dir="auto">Testing</h2>\n<p dir='
        '"auto">Ran the suite.</p>\n<section data-footnotes="" class="foo'
        'tnotes"><h2 id="footnote-label" class="sr-only" dir="auto">Footn'
        'otes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1-956cfa1622'
        f'1a7f456af446179cc56569">\n<p dir="auto">Also {GITHUB_ISSUE_104}'
        ' <a href="#user-content-fnref-1-956cfa16221a7f456af446179cc56569'
        '" data-footnote-backref="" aria-label="Back to reference 1" clas'
        's="data-footnote-backref">↩</a></p>\n</li>\n</ol>\n</section>'),
    'empty_testing_with_footnote': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-581d760'
        'a270e7fee0da7477a35a53366" id="user-content-fnref-1-581d760a270e'
        '7fee0da7477a35a53366" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup></p>\n<h2 dir="auto">Testing</h2>\n<sect'
        'ion data-footnotes="" class="footnotes"><h2 id="footnote-label" '
        'class="sr-only" dir="auto">Footnotes</h2>\n<ol dir="auto">\n<li '
        'id="user-content-fn-1-581d760a270e7fee0da7477a35a53366">\n<p dir'
        '="auto">Ran the suite. <a href="#user-content-fnref-1-581d760a27'
        '0e7fee0da7477a35a53366" data-footnote-backref="" aria-label="Bac'
        'k to reference 1" class="data-footnote-backref">↩</a></p>\n</li>'
        '\n</ol>\n</section>'),
    'no_class': (
        _HEAD
        + _PLAIN
        + '<section data-footnotes="" class="footnotes"><h2 id="footnote-la'
        'bel" class="sr-only" dir="auto">Footnotes</h2>\n<p dir="auto">Fi'
        f'xes {GITHUB_ISSUE_104}</p>\n</section>'),
    'no_dataattr': (
        _HEAD
        + _PLAIN
        + f'<section>\n<p dir="auto">Fixes {GITHUB_ISSUE_104}</p>\n</sectio'
        'n>'),
    'own_heading': (
        _HEAD
        + _PLAIN
        + '<section data-footnotes="" class="footnotes"><h2 id="footnote-la'
        'bel" class="sr-only" dir="auto">Footnotes</h2>\n<h2 dir="auto">E'
        f'xtra</h2>\n<p dir="auto">Fixes {GITHUB_ISSUE_104}</p>\n</sectio'
        'n>'),
    'plain_div': (
        _HEAD
        + _PLAIN
        + f'<div dir="auto">\n<p dir="auto">Fixes {GITHUB_ISSUE_104}</p>\n<'
        '/div>'),
    'heading_wrapped': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <section da'
        'ta-footnotes="" class="footnotes"><h2 id="footnote-label" class='
        '"sr-only" dir="auto">Footnotes</h2></section></h2>'),
    'heading_wrapped_ref': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <section da'
        'ta-footnotes="" class="footnotes"><h2 id="footnote-label" class='
        f'"sr-only" dir="auto">Footnotes</h2>Fixes {GITHUB_ISSUE_104}</se'
        'ction></h2>'),
    'forged_label': (
        _HEAD
        + _RAN_IT
        + '<h2 id="user-content-footnote-label" dir="auto">Trap</h2>'),
    'forged_label_in_section': (
        _HEAD
        + _RAN_IT
        + '<section data-footnotes="" class="footnotes"><h2 id="footnote-la'
        'bel" class="sr-only" dir="auto">Footnotes</h2>\n<h2 id="user-con'
        'tent-footnote-label" dir="auto">Trap</h2>\n<p dir="auto">Fixes '
        f'{GITHUB_ISSUE_104}</p>\n</section>'),
    'author_footnotes_heading': (
        _HEAD
        + _RAN_IT
        + '<h2 dir="auto">Footnotes</h2>\n<p dir="auto">Fixes '
        f'{GITHUB_ISSUE_104}</p>'),
    'id_only': (
        _HEAD
        + _RAN_IT_REF
        + '<h2 id="user-content-footnote-label" dir="auto">Trap</h2>'),
    'class_only': (
        _HEAD
        + _RAN_IT_REF
        + '<h2 dir="auto">Trap</h2>'),
    'id_upper_attr': (
        _HEAD
        + _RAN_IT_REF
        + '<h2 id="user-content-footnote-label" dir="auto">Trap</h2>'),
    'two_sections': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-6ded4ed'
        '1858c945685fa4b4e5286e793" id="user-content-fnref-1-6ded4ed1858c'
        '945685fa4b4e5286e793" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup></p>\n<h2 dir="auto">Testing</h2>\n<p di'
        'r="auto">Ran it.</p>\n<section data-footnotes="" class="footnote'
        's"><h2 id="footnote-label" class="sr-only" dir="auto">Footnotes<'
        f'/h2>\n<p dir="auto">Fixes {GITHUB_ISSUE_104}</p>\n</section>\n<'
        'section data-footnotes="" class="footnotes"><h2 id="footnote-lab'
        'el" class="sr-only" dir="auto">Footnotes</h2>\n<ol dir="auto">\n'
        '<li id="user-content-fn-1-6ded4ed1858c945685fa4b4e5286e793">\n<p'
        f' dir="auto">Fixes {GITHUB_ISSUE_105} <a href="#user-content-fnr'
        'ef-1-6ded4ed1858c945685fa4b4e5286e793" data-footnote-backref="" '
        'aria-label="Back to reference 1" class="data-footnote-backref">↩'
        '</a></p>\n</li>\n</ol>\n</section>'),
    'label_no_footnote': (
        _HEAD
        + _RAN_IT
        + '<h2 id="user-content-footnote-label" dir="auto">Trap</h2>\n<p di'
        f'r="auto">Fixes {GITHUB_ISSUE_104}</p>'),
    'wrapper_then_text': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing</h2>\n<section'
        ' data-footnotes="" class="footnotes"><h2 id="footnote-label" class="s'
        'r-only" dir="auto">Footnotes</h2></section>\n<p dir="auto">Ran the su'
        'ite.</p>'),
    'related_wrapper_then_ref': (
        '<h2 dir="auto">Summary</h2>\n<p dir="auto">One sentence.</p>\n<h2 dir'
        '="auto">Related Issues and Pull Requests</h2>\n<p dir="auto">Fixes '
        f'{GITHUB_ISSUE_101}</p>\n<section data-footnotes="" class="footnotes"'
        '><h2 id="footnote-label" class="sr-only" dir="auto">Footnotes</h2>\n<'
        'p dir="auto">note</p>\n</section>\n<p dir="auto">See '
        f'{GITHUB_ISSUE_104}</p>\n<h2 dir="auto">Changes</h2>\n<p dir="auto">O'
        'ne change</p>\n<h2 dir="auto">Testing</h2>\n<p dir="auto">Ran the sui'
        'te.</p>'),
    'heading_keyword_across_wrapper': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing fixes '
        f'{GITHUB_ISSUE_104}, <section data-footnotes="" class="footnotes"><h2'
        ' id="footnote-label" class="sr-only" dir="auto">Footnotes</h2>'
        f'{GITHUB_ISSUE_105}</section></h2>'),
    'definition_heading': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-78b771a'
        'd2aa2098c7b5ba094abd57c48" id="user-content-fnref-1-78b771ad2aa2'
        '098c7b5ba094abd57c48" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup></p>\n<section data-footnotes="" class="'
        'footnotes"><h2 id="footnote-label" class="sr-only" dir="auto">Fo'
        'otnotes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1-78b771a'
        'd2aa2098c7b5ba094abd57c48">\n<p dir="auto">A note</p>\n<h2 dir="'
        'auto">Testing</h2>\n<a href="#user-content-fnref-1-78b771ad2aa20'
        '98c7b5ba094abd57c48" data-footnote-backref="" aria-label="Back t'
        'o reference 1" class="data-footnote-backref">↩</a>\n</li>\n</ol>'
        '\n</section>'),
    'definition_heading_text': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-4e81328'
        '27f8dfcc1826f2f864bd758ca" id="user-content-fnref-1-4e8132827f8d'
        'fcc1826f2f864bd758ca" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup></p>\n<section data-footnotes="" class="'
        'footnotes"><h2 id="footnote-label" class="sr-only" dir="auto">Fo'
        'otnotes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1-4e81328'
        '27f8dfcc1826f2f864bd758ca">\n<p dir="auto">A note</p>\n<h2 dir="'
        'auto">Testing</h2>\n<p dir="auto">Ran it. <a href="#user-content'
        '-fnref-1-4e8132827f8dfcc1826f2f864bd758ca" data-footnote-backref'
        '="" aria-label="Back to reference 1" class="data-footnote-backre'
        'f">↩</a></p>\n</li>\n</ol>\n</section>'),
    'two_definitions': (
        _HEAD
        + '<p dir="auto">One change<sup><a href="#user-content-fn-1-f123cd0'
        '4424734aa76b0af70f8c07b2d" id="user-content-fnref-1-f123cd044247'
        '34aa76b0af70f8c07b2d" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">1</a></sup><sup><a href="#user-content-fn-2-f123cd0'
        '4424734aa76b0af70f8c07b2d" id="user-content-fnref-2-f123cd044247'
        '34aa76b0af70f8c07b2d" data-footnote-ref="" aria-describedby="foo'
        'tnote-label">2</a></sup></p>\n<h2 dir="auto">Testing</h2>\n<sect'
        'ion data-footnotes="" class="footnotes"><h2 id="footnote-label" '
        'class="sr-only" dir="auto">Footnotes</h2>\n<ol dir="auto">\n<li '
        'id="user-content-fn-1-f123cd04424734aa76b0af70f8c07b2d">\n<p dir'
        '="auto">Ran the suite. <a href="#user-content-fnref-1-f123cd0442'
        '4734aa76b0af70f8c07b2d" data-footnote-backref="" aria-label="Bac'
        'k to reference 1" class="data-footnote-backref">↩</a></p>\n</li>'
        '\n<li id="user-content-fn-2-f123cd04424734aa76b0af70f8c07b2d">\n'
        f'<p dir="auto">second {GITHUB_ISSUE_105} <a href="#user-content-f'
        'nref-2-f123cd04424734aa76b0af70f8c07b2d" data-footnote-backref="'
        '" aria-label="Back to reference 2" class="data-footnote-backref"'
        '>↩</a></p>\n</li>\n</ol>\n</section>'),
    'wrapper_heading_then_resume': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing</h2>\n<section'
        ' data-footnotes="" class="footnotes"><h2 id="footnote-label" class='
        '"sr-only" dir="auto">Footnotes</h2>\n<h2 dir="auto">Extra</h2>\n</s'
        'ection>\n<p dir="auto">Ran it.</p>'),
    'definition_empty_heading_list': (
        _HEAD
        + '<p dir="auto">One change</p>\n<p dir="auto">One more<sup><a href="#'
        'user-content-fn-1-611d14517e47dce8af90a735c94444b1" id="user-conten'
        't-fnref-1-611d14517e47dce8af90a735c94444b1" data-footnote-ref="" ar'
        'ia-describedby="footnote-label">1</a></sup></p>\n<h2 dir="auto">Tes'
        'ting</h2>\n<p dir="auto">Ran it.</p>\n<section data-footnotes="" cl'
        'ass="footnotes"><h2 id="footnote-label" class="sr-only" dir="auto">'
        'Footnotes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1-611d1451'
        f'7e47dce8af90a735c94444b1">\n<p dir="auto">Fixes {GITHUB_ISSUE_104},'
        f' </p><h2 dir="auto"></h2> {GITHUB_ISSUE_105} <a href="#user-content'
        '-fnref-1-611d14517e47dce8af90a735c94444b1" data-footnote-backref=""'
        ' aria-label="Back to reference 1" class="data-footnote-backref">↩</'
        'a><p dir="auto"></p>\n</li>\n</ol>\n</section>'),
    'wrapper_div_list': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing</h2>\n<sect'
        'ion data-footnotes="" class="footnotes"><h2 id="footnote-label" '
        'class="sr-only" dir="auto">Footnotes</h2>\nFixes '
        f'{GITHUB_ISSUE_104}, <div dir="auto">{GITHUB_ISSUE_105}</div>\n</'
        'section>\n<p dir="auto">Ran it.</p>'),
}

NESTED_HEADING_HTML = {
    'div_in_heading': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <div dir="'
        'auto"><h3 dir="auto">Inner</h3></div></h2>'),
    'two_headings_in_div': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <div dir="'
        'auto"><h3 dir="auto">a</h3><h3 dir="auto">b</h3></div></h2>'),
    'raw_section_in_heading': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <section><h'
        '2 dir="auto">Inner</h2></section></h2>'),
    'footnote_section_in_heading': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <section da'
        'ta-footnotes="" class="footnotes"><h2 id="footnote-label" class='
        '"sr-only" dir="auto">Footnotes</h2><h2 dir="auto">Inner</h2></se'
        'ction></h2>'),
    'forged_label_in_heading': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <section da'
        'ta-footnotes="" class="footnotes"><h2 id="footnote-label" class='
        '"sr-only" dir="auto">Footnotes</h2><h2 id="user-content-footnote'
        '-label" dir="auto">Trap</h2></section></h2>'),
    'empty_heading_in_div': (
        _HEAD
        + '<p dir="auto">One change</p>\n<h2 dir="auto">Testing <div dir="a'
        'uto"><h3 dir="auto"></h3></div></h2>\n<p dir="auto">Ran it.</p>'),
}

# Spelled out rather than imported from pr_body, so a flip of the
# production string turns the assertions that read it red.
NESTED_HEADING_NOTE = (
    'A heading is nested inside another heading; remove the raw HTML '
    'element from that heading line.')

RELATED = PR_BODY.RELATED


# What each capture's sections come to once its footnote section is
# read like any other content and GitHub's injected label heading opens
# none of its own. no_dataattr carries no label at all, because GitHub
# keys on data-footnotes: it normalises that attribute up into the
# generated spelling and drops a footnotes class arriving without it.
# Every trap row is an author heading whose forged attributes GitHub
# rewrote or dropped - class_only carries neither - so it opens a
# section the way any other author heading does, unless it stands
# inside a footnote section: own_heading and forged_label_in_section
# open none, because nothing but its element's end leaves the region
# the injected label opens.
_BASE_KEYS = ('summary', RELATED, 'changes', 'testing')
FOOTNOTE_SECTIONS = (
    ('footnote_definition_closing', _BASE_KEYS),
    ('footnote_definition_bare', _BASE_KEYS),
    ('raw_section', _BASE_KEYS),
    ('footnote_in_related', _BASE_KEYS),
    ('empty_testing_with_footnote', _BASE_KEYS),
    ('no_class', _BASE_KEYS),
    ('no_dataattr', _BASE_KEYS),
    ('plain_div', _BASE_KEYS),
    ('two_sections', _BASE_KEYS),
    ('heading_wrapped', _BASE_KEYS),
    ('own_heading', _BASE_KEYS),
    ('forged_label', _BASE_KEYS + ('trap',)),
    ('forged_label_in_section', _BASE_KEYS),
    ('id_only', _BASE_KEYS + ('trap',)),
    ('class_only', _BASE_KEYS + ('trap',)),
    ('id_upper_attr', _BASE_KEYS + ('trap',)),
    ('label_no_footnote', _BASE_KEYS + ('trap',)),
    ('author_footnotes_heading', _BASE_KEYS + ('footnotes',)),
    ('heading_wrapped_ref', _BASE_KEYS),
    ('wrapper_then_text', _BASE_KEYS),
    ('related_wrapper_then_ref', _BASE_KEYS),
    ('heading_keyword_across_wrapper',
     ('summary', RELATED, 'changes', 'testing fixes #104,')),
    ('definition_heading', ('summary', RELATED, 'changes')),
    ('definition_heading_text', ('summary', RELATED, 'changes')),
    ('two_definitions', _BASE_KEYS),
    ('wrapper_heading_then_resume', _BASE_KEYS),
    ('definition_empty_heading_list', _BASE_KEYS),
    ('wrapper_div_list', _BASE_KEYS),
)

# A footnote definition renders at the end of the document, so its
# references sit outside Related Issues and Pull Requests. A wrapper an
# author writes can sit inside that section instead, where a reference
# after it is the section's own again.
FOOTNOTE_REFERENCED = [101]
FOOTNOTE_REFERENCED_BY_ROW = {'related_wrapper_then_ref': [101, 104]}


def _undefined(name):
    return f'Section `{name}` is not defined by the template.'


# The template defines no Footnotes section and the parser opens none,
# so a conforming body is judged exactly as it would be without its
# footnotes. What an author writes is judged too: author_footnotes_
# heading is a section the template does not define, and the trap rows
# outside a footnote section are the same refusal reached through a
# forged label attribute GitHub rewrote or dropped. A heading inside
# one is judged not at all: definition_heading is missing its Testing
# section rather than holding an undefined one.
_TRAP = [_undefined('Trap')]
_MISSING_TESTING = ['Required section "Testing" is missing.']
FOOTNOTE_LAYOUT = (
    ('footnote_definition_closing', []),
    ('footnote_definition_bare', []),
    ('raw_section', []),
    ('footnote_in_related', []),
    ('no_class', []),
    ('no_dataattr', []),
    ('plain_div', []),
    ('two_sections', []),
    ('own_heading', []),
    ('forged_label_in_section', []),
    ('empty_testing_with_footnote', ['Section "Testing" is empty.']),
    ('heading_wrapped', ['Section "Testing" is empty.']),
    ('author_footnotes_heading', [_undefined('Footnotes')]),
    ('forged_label', _TRAP),
    ('id_only', _TRAP),
    ('class_only', _TRAP),
    ('id_upper_attr', _TRAP),
    ('label_no_footnote', _TRAP),
    ('heading_wrapped_ref', ['Section "Testing" is empty.']),
    ('wrapper_then_text', []),
    ('related_wrapper_then_ref', []),
    ('heading_keyword_across_wrapper',
     [_undefined('Testing fixes #104,'),
      'Required section "Testing" is missing.']),
    ('definition_heading', _MISSING_TESTING),
    ('definition_heading_text', _MISSING_TESTING),
    ('two_definitions', ['Section "Testing" is empty.']),
    ('wrapper_heading_then_resume', []),
    ('definition_empty_heading_list', []),
    ('wrapper_div_list', []),
)
