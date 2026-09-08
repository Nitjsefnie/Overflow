#!/usr/bin/env python3
"""The closing-keyword grammar of a rendered pull-request body.

The keyword spellings, the run of text a keyword must end, the
separator that carries a keyword across a reference list, and the
decision itself: whether the text before an issue reference governs
that reference as a closing one.
"""

import re


_CLOSING_KEYWORDS = frozenset((
    'close', 'closes', 'closed', 'fix', 'fixes', 'fixed',
    'resolve', 'resolves', 'resolved'))
_TRAILING_KEYWORD = re.compile(
    r'(?<!\w)(?:'
    + '|'.join(re.escape(word) for word in sorted(_CLOSING_KEYWORDS))
    + r')\Z', re.IGNORECASE)
_LIST_SEPARATOR = re.compile(r'[\s,&]*(?:and[\s,&]*)*', re.IGNORECASE)


def _gap_closing(run, gap, previous_closing):
    """Whether the text before an anchor governs it as a closing one.

    GitHub matches on the run of text ending AT the reference, bounded
    on its left by the nearest element boundary: that run ends with a
    keyword, no word character before it, then at most one colon, then
    spaces or tabs. The reference may equally be a `GH-N`, a bare URL
    or an explicit link, since it ends the run rather than interrupting
    it.

    Both sides of the boundary follow: `**Fixes** #N` is inert and
    `*a*fixes #N` closes. The narrow side is measured too: trailing
    punctuation is refused because GitHub was found not to act on it.

    Folding is required rather than extra width: `fixeſ #N` closes on
    GitHub and folds to `fixes` here, so an ASCII-only or fold-free
    match would refuse a spelling it acts on. `FİXES #N` is the one
    measured spelling folding admits and GitHub ignores.

    The deliberate widths, all in the safe direction: whitespace
    GitHub does not take, so a no-break space closes; no separator at
    all or a colon with no space, reachable as `Fixes[#N](url)` and
    `Fixes:#N`; a line whose first character opens a raw tag, which
    GitHub declines to scan and this cannot see; and the keyword-list
    continuation, past an anchor GitHub stops at. Matching its
    separator exactly needs both halves: the strip limited to spaces
    and tabs, and one required between keyword and reference. Failing
    closed is preferred, since the cost is a refusal GitHub would not
    have made against a bypass of the claim check this feeds.
    """
    before_separator = run.rstrip().removesuffix(':').rstrip()
    if _TRAILING_KEYWORD.search(before_separator):
        return True
    return (bool(previous_closing)
            and _LIST_SEPARATOR.fullmatch(gap) is not None)
