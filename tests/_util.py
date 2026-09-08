"""Standard-library runner and module loader for the focused gate suites."""
import importlib.util
import sys
import tempfile
import traceback
from pathlib import Path


def load(path, name):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def collect(namespace):
    return [value for name, value in namespace.items()
            if name.startswith('test_') and callable(value)]


def runner(tests, *, tmp_prefix):
    failures = 0
    for test in tests:
        try:
            with tempfile.TemporaryDirectory(prefix=tmp_prefix) as directory:
                test(Path(directory))
        except Exception:
            failures += 1
            print(f'FAIL {test.__name__}', file=sys.stderr)
            traceback.print_exc()
    print(f'{len(tests) - failures} passed, {failures} failed')
    return int(bool(failures))
