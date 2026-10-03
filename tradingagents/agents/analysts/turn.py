"""A tool-using analyst's turn and its final turn after its tool budget is spent."""

import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

WRAP_UP = (
    "You have used every tool round this report allows. Write your final report "
    "now from the tool results above, and say which data you could not retrieve."
)


def take_turn(prompt, llm, tools, messages):
    """Return the model message and a report only once it stops calling tools."""
    if messages and isinstance(messages[-1], HumanMessage) and messages[-1].content == WRAP_UP:
        prompt = prompt.partial(tool_names="none; your tool rounds are spent")
        result = (prompt | llm).invoke(_as_text(messages))
        return result, result.content
    result = (prompt | llm.bind_tools(tools)).invoke(messages)
    return result, "" if result.tool_calls else result.content


def _as_text(messages):
    """Preserve collected evidence without provider-specific tool-message constraints."""
    written = []
    for message in messages:
        if isinstance(message, AIMessage) and message.tool_calls:
            said = message.content if isinstance(message.content, str) else ""
            calls = "; ".join(
                f"{call['name']}({json.dumps(call['args'], default=str)})"
                for call in message.tool_calls
            )
            written.append(AIMessage(content=f"{said}\n[Called {calls}]".strip()))
        elif isinstance(message, ToolMessage):
            written.append(
                HumanMessage(content=f"[{message.name or 'Tool'} returned]\n{message.content}")
            )
        else:
            written.append(message)
    return written
