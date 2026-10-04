"""Offline, explicit selected-claim evaluation; no research/model execution."""

from .guards import FrozenEvaluationError, FrozenEvaluationIOError
from .io import evaluate_file
from .pack import validate_pack
from .report import validate_research_report
from .runner import evaluate_pack, validate_evaluation_result

__all__ = [
    "FrozenEvaluationError",
    "FrozenEvaluationIOError",
    "evaluate_file",
    "validate_pack",
    "validate_research_report",
    "evaluate_pack",
    "validate_evaluation_result",
]
