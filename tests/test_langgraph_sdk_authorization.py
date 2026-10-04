"""Regress SDK handler registration without a server or authenticated requests.

The public decorators return the handler, so the private registration table is
inspected to detect GHSA-fvww-7h3r-vfhp. These checks do not establish that the
application uses custom server authorization or that requests are authorized.
"""

import pytest
from langgraph_sdk import Auth


async def _handler(ctx, value):
    return None


@pytest.mark.parametrize("resource", ["threads", "assistants", "crons"])
@pytest.mark.parametrize(
    "actions",
    [["create"], ["create", "update"], "create"],
    ids=["one-action-list", "two-action-list", "one-action-string"],
)
def test_resource_decorator_registers_only_selected_actions(resource, actions):
    auth = Auth()
    returned = getattr(auth.on, resource)(actions=actions)(_handler)

    selected = [actions] if isinstance(actions, str) else actions
    assert returned is _handler
    assert set(auth._handlers) == {(resource, action) for action in selected}
    assert (resource, "*") not in auth._handlers


@pytest.mark.parametrize("resource", ["threads", "assistants", "crons"])
def test_unfiltered_resource_decorator_registers_wildcard(resource):
    auth = Auth()
    returned = getattr(auth.on, resource)(_handler)

    assert returned is _handler
    assert set(auth._handlers) == {(resource, "*")}


@pytest.mark.parametrize("resource", ["threads", "assistants", "crons"])
def test_direct_action_decorator_registers_only_that_action(resource):
    auth = Auth()
    returned = getattr(auth.on, resource).create(_handler)

    assert returned is _handler
    assert set(auth._handlers) == {(resource, "create")}
