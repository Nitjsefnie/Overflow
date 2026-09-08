"""The repository supplied by Actions reaches GitHub's Markdown boundary."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _util
from _prgate import (
    CLI_FOOTER_BODY, CLI_FOOTER_HTML, FakeApi, ROOT, _gate_module,
    _issue, _pull, _valid_body, _valid_html,
)


class RepositoryApi(FakeApi):
    def __init__(self, repository):
        super().__init__(pull=_pull(), issues={'101': _issue('alice')},
                         rendered=_valid_html(repo=repository) + CLI_FOOTER_HTML)
        self.repository = repository
        self.markdown_contexts = []

    def _endpoint(self, endpoint):
        prefix = f'repos/{self.repository}/'
        assert endpoint.startswith(prefix), endpoint
        return 'repos/owner/repo/' + endpoint[len(prefix):]

    def request(self, method, endpoint, payload=None):
        if endpoint == 'markdown':
            self.markdown_contexts.append(payload['context'])
        else:
            endpoint = self._endpoint(endpoint)
        return super().request(method, endpoint, payload)

    def paginate(self, endpoint):
        return super().paginate(self._endpoint(endpoint))


def test_markdown_context_follows_each_actual_repository(tmp):
    del tmp
    template = (ROOT / '.github/PULL_REQUEST_TEMPLATE.md').read_text(encoding='utf-8')
    for repository in ('Nitjsefnie/Overflow', 'another-owner/another-repository'):
        api = RepositoryApi(repository)
        api.pull['body'] = _valid_body() + CLI_FOOTER_BODY
        assert _gate_module().run(api, repository, '99', 'alice', template) == 0
        assert api.markdown_contexts == [repository]
        assert api.pull['state'] == 'open' and api.writes == []


if __name__ == '__main__':
    raise SystemExit(_util.runner(_util.collect(globals()), tmp_prefix='prcontext_'))
