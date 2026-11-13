#!/usr/bin/env python3
"""Shared BibTeX parsing and rendering for the citation-management scripts.

Standard library only.

The parser here is brace-depth aware. That matters more than it sounds: a
regular expression of the form ``\\{([^}]*)\\}`` stops at the first closing
brace, so it truncates every title that protects a capitalised term --
``{Highly accurate prediction with {AlphaFold}}`` -- and writing the truncated
value back out produces a ``.bib`` file with unbalanced braces that no BibTeX
engine will read. Capitalisation protection is routine in real bibliographies,
and ``extract_metadata.py`` emits it deliberately, so the naive form corrupts
this skill's own output.

Every producer in this skill renders through :func:`render_entry` and keys
through :func:`citation_key`, so entries from Crossref, PubMed, OpenAlex, and
Scholar are directly comparable and deduplication works across sources.
"""

from __future__ import annotations

import re
import sys
import unicodedata
from collections import OrderedDict
from typing import Dict, List, Optional

# Field order used when rendering. Anything not listed keeps its input order
# and is appended after these.
FIELD_ORDER = [
    'author', 'editor', 'title', 'booktitle', 'journal',
    'year', 'month', 'volume', 'number', 'pages',
    'publisher', 'address', 'edition', 'series',
    'school', 'institution', 'organization',
    'howpublished', 'doi', 'url', 'isbn', 'issn',
    'note', 'abstract', 'keywords',
]

# @string, @comment and @preamble are not bibliography entries.
_NON_ENTRY_TYPES = {'string', 'comment', 'preamble'}

_FIELD_NAME = re.compile(r'\s*([A-Za-z][A-Za-z0-9_+:.-]*)\s*=\s*(.*)$', re.DOTALL)


def _is_outer_braced(value: str) -> bool:
    """True when the whole value is wrapped in one matched brace pair."""
    if not (value.startswith('{') and value.endswith('}')):
        return False
    depth = 0
    for index, char in enumerate(value):
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                # Only a wrapper if it closes at the very end; `{a} # {b}`
                # and `{a}{b}` must be left alone.
                return index == len(value) - 1
    return False


def _unwrap(value: str) -> str:
    """Strip one layer of delimiters, preserving any nested braces inside."""
    value = value.strip()
    if _is_outer_braced(value):
        return value[1:-1].strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1].strip()
    return value


def _split_top_level(body: str) -> List[str]:
    """Split on commas that sit outside braces and quotes."""
    parts: List[str] = []
    buffer: List[str] = []
    depth = 0
    in_quote = False

    for char in body:
        if char == '"' and depth == 0:
            in_quote = not in_quote
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1

        if char == ',' and depth == 0 and not in_quote:
            parts.append(''.join(buffer))
            buffer = []
        else:
            buffer.append(char)

    parts.append(''.join(buffer))
    return parts


def parse_bibtex(content: str) -> List[Dict]:
    """Parse BibTeX source into entry dictionaries.

    Each entry is ``{'type', 'key', 'fields', 'raw'}`` with ``fields`` an
    ``OrderedDict`` of lowercased field names to their unwrapped values.
    Malformed or unterminated entries are skipped rather than raised on.
    """
    entries: List[Dict] = []
    length = len(content)
    position = 0

    while True:
        at = content.find('@', position)
        if at < 0:
            break

        cursor = at + 1
        while cursor < length and content[cursor].isalpha():
            cursor += 1
        entry_type = content[at + 1:cursor].lower()

        if not entry_type:
            position = at + 1
            continue

        while cursor < length and content[cursor].isspace():
            cursor += 1

        if cursor >= length or content[cursor] not in '{(':
            position = at + 1
            continue

        opener = content[cursor]
        closer = '}' if opener == '{' else ')'

        # Walk to the delimiter that matches the opener, counting depth.
        depth = 0
        end = -1
        scan = cursor
        while scan < length:
            char = content[scan]
            if char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    end = scan
                    break
            scan += 1

        if end < 0:
            # Unterminated entry: nothing reliable left to read.
            break

        position = end + 1

        if entry_type in _NON_ENTRY_TYPES:
            continue

        body = content[cursor + 1:end]
        chunks = _split_top_level(body)
        if not chunks:
            continue

        citation_key_text = chunks[0].strip()
        if not citation_key_text or '=' in citation_key_text:
            # No citation key -- not an entry we can work with.
            continue

        fields: "OrderedDict[str, str]" = OrderedDict()
        for chunk in chunks[1:]:
            if not chunk.strip():
                continue
            match = _FIELD_NAME.match(chunk)
            if not match:
                continue
            fields[match.group(1).lower()] = _unwrap(match.group(2))

        entries.append({
            'type': entry_type,
            'key': citation_key_text,
            'fields': fields,
            'raw': content[at:end + 1],
        })

    return entries


def parse_bibtex_file(filepath: str) -> List[Dict]:
    """Parse a BibTeX file, reporting read errors rather than raising."""
    try:
        with open(filepath, 'r', encoding='utf-8') as handle:
            return parse_bibtex(handle.read())
    except OSError as error:
        print(f'Error reading file: {error}', file=sys.stderr)
        return []


def render_entry(entry_type: str, key: str, fields: Dict[str, str]) -> str:
    """Render one entry with fields in a stable order and aligned values.

    Empty values are dropped, so callers can pass a dictionary built from
    metadata that may or may not have been populated.
    """
    present = OrderedDict()
    for name in FIELD_ORDER:
        value = fields.get(name)
        if value:
            present[name] = str(value)
    for name, value in fields.items():
        if name not in present and value:
            present[name] = str(value)

    if not present:
        return f'@{entry_type}{{{key},\n}}'

    width = max(len(name) for name in present)
    lines = [f'@{entry_type}{{{key},']
    rendered = [f'  {name.ljust(width)} = {{{value}}}' for name, value in present.items()]
    lines.append(',\n'.join(rendered))
    lines.append('}')
    return '\n'.join(lines)


_PAGE_RANGE = re.compile(r'^(\d+)\s*(?:-{1,3}|–|—)\s*(\d+)$')


def format_pages(raw: Optional[str]) -> str:
    """Normalise a page field to a BibTeX en-dash range.

    Handles the two mistakes the previous per-script implementations made:
    a blanket ``replace('-', '--')`` turned an already-correct ``583--589``
    into ``583----589``, and PubMed's abbreviated ``MedlinePgn`` ranges
    (``1123-30``) need their end page expanded to ``1123--1130`` rather than
    being left as a nonsensical ``1123--30``.

    Values that are not ranges -- article numbers such as ``e0123456``,
    or discontinuous lists -- are returned unchanged.
    """
    if not raw:
        return ''

    pages = re.sub(r'^\s*pp?\.\s*', '', str(raw).strip(), flags=re.IGNORECASE)
    match = _PAGE_RANGE.match(pages)
    if not match:
        return pages

    start, end = match.group(1), match.group(2)
    if len(end) < len(start):
        end = start[:len(start) - len(end)] + end
    return f'{start}--{end}'


def _ascii_fold(text: str) -> str:
    """Reduce accented Latin characters to ASCII (Muller from Müller)."""
    decomposed = unicodedata.normalize('NFKD', text)
    return ''.join(char for char in decomposed if not unicodedata.combining(char))


def sanitize_key(text: str) -> str:
    """Reduce a string to characters that are safe in a BibTeX citation key.

    Keys reach both LaTeX and, in some workflows, the filesystem, and their
    source is a publisher-controlled metadata record. Restricting them to
    ASCII letters and digits keeps `O'Brien` and `Müller` from producing an
    entry that LaTeX rejects.
    """
    return re.sub(r'[^A-Za-z0-9]', '', _ascii_fold(text or ''))


def _looks_like_initials(word: str) -> bool:
    """True for `J`, `JA`, `J.A.` -- the initials half of a PubMed author."""
    stripped = word.replace('.', '')
    return bool(stripped) and len(stripped) <= 3 and stripped.isupper()


def citation_key(authors: str, year: str, title: str) -> str:
    """Build the citation key used by every producer in this skill.

    ``<FirstAuthorSurname><Year><FirstSubstantiveTitleWord>``, ASCII-folded and
    stripped of anything outside ``[A-Za-z0-9]``. Sharing one scheme across
    Crossref, PubMed, OpenAlex, and Scholar output is what makes the
    deduplication in ``format_bibtex.py`` and ``validate_citations.py`` able to
    see the same paper twice.
    """
    surname = ''
    if authors:
        first = authors.split(' and ')[0].strip()
        if ',' in first:
            surname = first.split(',')[0]
        else:
            words = first.split()
            if not words:
                surname = ''
            elif len(words) > 1 and _looks_like_initials(words[-1]):
                # PubMed's comma-less form puts the surname first: `Smith JA`.
                surname = words[0]
            else:
                # Western given-name-first order: `John Smith`.
                surname = words[-1]

    surname = sanitize_key(surname) or 'unknown'

    digits = re.sub(r'[^0-9]', '', str(year or ''))
    year_part = digits[:4] if digits else 'XXXX'

    words = re.findall(r'[A-Za-z]{4,}', _ascii_fold(title or ''))
    keyword = words[0].lower() if words else 'paper'

    return f'{surname}{year_part}{keyword}'


# Terms whose capitalisation BibTeX would otherwise flatten in a title.
PROTECTED_TERMS = [
    'AlphaFold', 'CRISPR', 'COVID', 'SARS', 'DNA', 'RNA', 'mRNA', 'HIV',
    'AIDS', 'MRI', 'PCR', 'USA', 'UK', 'EU', 'GPU', 'CPU', 'AI', 'ML',
]


def protect_title(title: str) -> str:
    """Brace terms whose capitalisation must survive BibTeX style processing.

    Terms already inside braces are left alone, so running this twice is safe.
    """
    if not title:
        return ''

    for term in PROTECTED_TERMS:
        # Skip occurrences already wrapped, so the function is idempotent.
        title = re.sub(
            rf'(?<!\{{)\b{re.escape(term)}\b(?!\}})',
            f'{{{term}}}',
            title,
        )
    return title
