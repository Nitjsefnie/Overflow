"""Interrupted reopen operations retain ownership until state is confirmed."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util
from _prgate import (
    BOT, CLOSED_MARKER, FakeApi, _RaceApi, _Response, _closed_event, _execute,
    _gate_comment, _issue, _pull, _valid_body,
)


class InterruptedApi(FakeApi):
    def __init__(self, failure, *, apply_state=False):
        super().__init__(pull=_pull('closed'), issues={'101': _issue('alice')},
                         comments=[_gate_comment(closed=True)],
                         timeline=[_closed_event()])
        self.failure = failure
        self.counts = {}
        self.apply_state = apply_state

    def _fails(self, method, endpoint):
        key = (method, endpoint.rsplit('/', 1)[-1])
        self.counts[key] = self.counts.get(key, 0) + 1
        return (*key, self.counts[key]) == self.failure

    def request(self, method, endpoint, payload=None):
        if self._fails(method, endpoint):
            if self.apply_state:
                super().request(method, endpoint, payload)
            return _Response(500, None)
        return super().request(method, endpoint, payload)

    def paginate(self, endpoint):
        if self._fails('GET', endpoint):
            return _Response(500, None)
        return super().paginate(endpoint)


def test_reopen_retries_each_interrupted_boundary(tmp):
    del tmp
    boundaries = (
        ('GET', '99', 2), ('GET', 'timeline', 2),
        ('PATCH', '7', 1),
        ('GET', '99', 3), ('GET', 'timeline', 3),
        ('PATCH', '99', 1),
        ('GET', '99', 4), ('GET', 'timeline', 4),
        ('PATCH', '7', 2),
    )
    for boundary in boundaries:
        api = InterruptedApi(boundary)
        code, _writes, _output, _error = _execute(api, _valid_body())
        assert code == 1, boundary
        assert CLOSED_MARKER in api.comments[0]['body'].splitlines(), boundary
        api.failure = None
        code, _writes, _output, _error = _execute(api, _valid_body())
        assert code == 0 and api.pull['state'] == 'open', boundary
        assert len(api.comments) == 1, boundary
        assert CLOSED_MARKER not in api.comments[0]['body'].splitlines(), boundary


def test_reopen_retry_reconciles_a_state_write_with_a_lost_response(tmp):
    del tmp
    api = InterruptedApi(('PATCH', '99', 1), apply_state=True)
    code, _writes, _output, _error = _execute(api, _valid_body())
    assert code == 1 and api.pull['state'] == 'open'
    api.failure = None
    assert _execute(api, _valid_body())[0] == 0
    assert api.pull['state'] == 'open' and len(api.comments) == 1
    assert CLOSED_MARKER not in api.comments[0]['body'].splitlines()


def test_retry_does_not_reopen_a_later_maintainer_close(tmp):
    del tmp
    api = InterruptedApi(('PATCH', '99', 1))
    assert _execute(api, _valid_body())[0] == 1
    assert CLOSED_MARKER in api.comments[0]['body'].splitlines()
    api.timeline.extend([
        {'event': 'reopened', 'actor': {'login': BOT}},
        _closed_event('maintainer'),
    ])
    api.failure = None
    before = list(api.writes)
    assert _execute(api, _valid_body())[0] == 0
    assert api.pull['state'] == 'closed' and api.writes == before


def test_maintainer_reclose_after_reopen_prevents_marker_cleanup_and_retry(tmp):
    del tmp
    api = _RaceApi(
        transition='reclosed', trigger='after-write', number=2,
        pull=_pull('closed'), issues={'101': _issue('alice')},
        comments=[_gate_comment(closed=True)], timeline=[_closed_event()])
    assert _execute(api, _valid_body())[0] == 1
    assert api.pull['state'] == 'closed'
    assert CLOSED_MARKER in api.comments[0]['body'].splitlines()
    assert len(api.writes) == 2
    assert _execute(api, _valid_body())[0] == 0
    assert len(api.writes) == 2 and api.pull['state'] == 'closed'


if __name__ == '__main__':
    raise SystemExit(_util.runner(_util.collect(globals()), tmp_prefix='prrecovery_'))
