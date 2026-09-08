#!/usr/bin/env python3
"""The instance-state-name guard for _RenderedBodyParser.

Relocated from tests/test_pr_body.py so that suite stays under its size
ceiling; the guard is machinery, not cases.
"""
import ast
import sys
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
ROOT = Path(__file__).resolve().parents[1]


def _is_self(node):
    return isinstance(node, ast.Name) and node.id == 'self'


def assigned_state_names():
    # Every spelling an instance name can take in the parser class: a
    # self.<name> store or del, setattr(self, '<name>', ...) and a
    # self.__dict__[<name>] store. Literal names only, and a nested def
    # with its own self is collected too, so the set can only
    # over-approximate; a spelling whose name is not a literal cannot be
    # enumerated and is refused instead of silently skipped.
    source = (ROOT / 'scripts' / 'ci' / 'pr_body.py').read_text(
        encoding='utf-8')
    parser_class = next(
        (node for node in ast.walk(ast.parse(source))
         if isinstance(node, ast.ClassDef)
         and node.name == '_RenderedBodyParser'), None)
    assert parser_class is not None, (
        'the _RenderedBodyParser anchor moved out of scripts/ci/pr_body.py')
    names = set()
    for node in ast.walk(parser_class):
        if isinstance(node, ast.Attribute):
            if (isinstance(node.ctx, (ast.Store, ast.Del))
                    and _is_self(node.value)):
                names.add(node.attr)
        elif (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == 'setattr'
                and node.args and _is_self(node.args[0])):
            assert (len(node.args) > 1
                    and isinstance(node.args[1], ast.Constant)
                    and isinstance(node.args[1].value, str)), (
                f'setattr on self needs a literal name: {ast.dump(node)}')
            names.add(node.args[1].value)
        elif (isinstance(node, ast.Subscript)
                and isinstance(node.ctx, ast.Store)
                and isinstance(node.value, ast.Attribute)
                and node.value.attr == '__dict__'
                and _is_self(node.value.value)):
            assert (isinstance(node.slice, ast.Constant)
                    and isinstance(node.slice.value, str)), (
                'a self.__dict__ store needs a literal name: '
                f'{ast.dump(node)}')
            names.add(node.slice.value)
    return names


def base_state_names():
    # Everything the running parser base owns: the instance attributes of a
    # fresh HTMLParser plus every class-level name in its MRO, dunders
    # excepted because overriding one is the normal extension mechanism.
    owned = set(vars(HTMLParser(convert_charrefs=False)))
    for ancestor in HTMLParser.__mro__:
        owned.update(
            name for name in ancestor.__dict__
            if not (name.startswith('__') and name.endswith('__')))
    return owned
