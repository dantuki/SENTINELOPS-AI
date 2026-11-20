"""Bounded, non-executing structural analysis of caller-provided Python text.

The module deliberately receives source *contents*, never filesystem paths to
open.  It uses the standard-library ``ast`` and ``tokenize`` modules only; it
does not import, compile, evaluate, or otherwise execute the analyzed code.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable, Mapping
from hashlib import sha256
from io import StringIO
import tokenize
from typing import Any, Literal, TypedDict


PYTHON_AST_VERSION = "python-ast-v1"
MAX_PYTHON_AST_FILES = 64
MAX_PYTHON_AST_FILE_BYTES = 128 * 1024
MAX_PYTHON_AST_TOTAL_BYTES = 1024 * 1024
MAX_PYTHON_AST_DEPTH = 96
MAX_PYTHON_AST_SYMBOLS_PER_FILE = 128
MAX_PYTHON_AST_RELATIONS_PER_FILE = 256

MetricPrecision = Literal[
    "exact_under_model", "approximate", "unknown", "not_applicable"
]


class PythonAstSource(TypedDict):
    """A bounded source unit supplied by the product API."""

    path: str
    content: str
    contentSha256: str
    byteLength: int


def _line_count(content: str) -> int:
    return 0 if not content else content.count("\n") + 1


def _hash(content: str) -> str:
    return sha256(content.encode("utf-8")).hexdigest()


def _safe_path(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 512
        or "\\" in value
        or value.startswith("/")
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError("invalid_source_path")
    return value


def _validated_source(value: Mapping[str, object]) -> PythonAstSource:
    path = _safe_path(value.get("path"))
    content = value.get("content")
    content_sha256 = value.get("contentSha256")
    byte_length = value.get("byteLength")
    if not isinstance(content, str):
        raise ValueError("invalid_source_content")
    encoded_length = len(content.encode("utf-8"))
    if encoded_length > MAX_PYTHON_AST_FILE_BYTES:
        raise ValueError("source_file_too_large")
    if (
        not isinstance(content_sha256, str)
        or len(content_sha256) != 64
        or any(character not in "0123456789abcdef" for character in content_sha256)
        or content_sha256 != _hash(content)
    ):
        raise ValueError("source_hash_mismatch")
    if not isinstance(byte_length, int) or isinstance(byte_length, bool) or byte_length != encoded_length:
        raise ValueError("source_byte_length_mismatch")
    return {
        "path": path,
        "content": content,
        "contentSha256": content_sha256,
        "byteLength": byte_length,
    }


def _code_lines(content: str) -> int | None:
    """Return non-comment, non-whitespace physical lines under this model."""
    lines: set[int] = set()
    ignored = {
        tokenize.COMMENT,
        tokenize.NL,
        tokenize.NEWLINE,
        tokenize.INDENT,
        tokenize.DEDENT,
        tokenize.ENDMARKER,
        tokenize.ENCODING,
    }
    try:
        for token in tokenize.generate_tokens(StringIO(content).readline):
            if token.type not in ignored:
                lines.add(token.start[0])
    except tokenize.TokenError:
        return None
    return len(lines)


def _node_line(node: ast.AST) -> int:
    return int(getattr(node, "lineno", 1))


def _node_end_line(node: ast.AST) -> int:
    return int(getattr(node, "end_lineno", _node_line(node)))


def _identifier(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parts = [node.attr]
        current: ast.expr = node.value
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            parts.append(current.id)
            return ".".join(reversed(parts))
    return None


def _parameter_count(node: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    arguments = node.args
    return (
        len(arguments.posonlyargs)
        + len(arguments.args)
        + len(arguments.kwonlyargs)
        + (1 if arguments.vararg else 0)
        + (1 if arguments.kwarg else 0)
    )


def _is_decision(node: ast.AST) -> int:
    if isinstance(
        node,
        (
            ast.If,
            ast.For,
            ast.AsyncFor,
            ast.While,
            ast.IfExp,
            ast.ExceptHandler,
            ast.comprehension,
        ),
    ):
        return 1
    if isinstance(node, ast.BoolOp):
        return max(0, len(node.values) - 1)
    if isinstance(node, ast.Match):
        return max(0, len(node.cases) - 1)
    return 0


def _is_nesting_construct(node: ast.AST) -> bool:
    return isinstance(
        node,
        (
            ast.If,
            ast.For,
            ast.AsyncFor,
            ast.While,
            ast.Try,
            ast.With,
            ast.AsyncWith,
            ast.Match,
        ),
    )


def _function_metrics(node: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[int, int]:
    """Compute complexity per function without charging nested definitions."""
    complexity = 1
    maximum_nesting = 0
    stack: list[tuple[ast.AST, int, bool]] = [(child, 0, False) for child in reversed(node.body)]
    while stack:
        current, nesting, _ = stack.pop()
        if current is not node and isinstance(
            current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
        ):
            continue
        decision = _is_decision(current)
        complexity += decision
        next_nesting = nesting + 1 if _is_nesting_construct(current) else nesting
        maximum_nesting = max(maximum_nesting, next_nesting)
        for child in reversed(list(ast.iter_child_nodes(current))):
            stack.append((child, next_nesting, False))
    return complexity, maximum_nesting


def _symbol(
    *,
    source: PythonAstSource,
    name: str,
    kind: str,
    qualified_name: str,
    node: ast.AST,
    parameter_count: int | None,
    decorator_count: int,
    cyclomatic_complexity: int | None,
) -> dict[str, object]:
    start_line = _node_line(node)
    return {
        "id": "symbol-" + sha256(
            f"{source['path']}:{source['contentSha256']}:{kind}:{qualified_name}:{start_line}".encode("utf-8")
        ).hexdigest()[:20],
        "name": name,
        "qualifiedName": qualified_name,
        "kind": kind,
        "startLine": start_line,
        "endLine": _node_end_line(node),
        "parameterCount": parameter_count,
        "decoratorCount": decorator_count,
        "cyclomaticComplexity": cyclomatic_complexity,
    }


def _empty_file_result(source: PythonAstSource, status: str) -> dict[str, object]:
    code_lines = _code_lines(source["content"])
    return {
        "path": source["path"],
        "contentSha256": source["contentSha256"],
        "language": "python",
        "status": status,
        "physicalLines": _line_count(source["content"]),
        "codeLines": code_lines,
        "metricPrecision": {
            "physicalLines": "exact_under_model",
            "codeLines": "exact_under_model" if code_lines is not None else "unknown",
            "cyclomaticComplexity": "unknown",
            "maxNesting": "unknown",
        },
        "cyclomaticComplexity": None,
        "maxNesting": None,
        "parseDiagnostics": 0,
        "constructCounts": {
            "if": 0,
            "for": 0,
            "asyncFor": 0,
            "while": 0,
            "try": 0,
            "except": 0,
            "with": 0,
            "asyncWith": 0,
            "return": 0,
            "raise": 0,
            "lambda": 0,
            "decorator": 0,
        },
        "symbols": [],
        "relations": [],
        "truncated": False,
    }


def _analyze_source(source: PythonAstSource) -> dict[str, object]:
    result = _empty_file_result(source, "parsed")
    try:
        root = ast.parse(source["content"], filename="<provided-python-source>", mode="exec")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        result["status"] = "syntax_error"
        result["parseDiagnostics"] = 1
        return result

    symbols: list[dict[str, object]] = []
    relations: list[dict[str, object]] = []
    constructs = result["constructCounts"]
    assert isinstance(constructs, dict)
    truncated = False
    complexity = 1
    maximum_nesting = 0
    stack: list[tuple[ast.AST, int, str]] = [(root, 0, "<module>")]
    while stack:
        node, depth, owner = stack.pop()
        if depth > MAX_PYTHON_AST_DEPTH:
            truncated = True
            continue
        decision = _is_decision(node)
        complexity += decision
        nesting = depth if _is_nesting_construct(node) else max(0, depth - 1)
        maximum_nesting = max(maximum_nesting, nesting)

        if isinstance(node, ast.If):
            constructs["if"] += 1
        elif isinstance(node, ast.For):
            constructs["for"] += 1
        elif isinstance(node, ast.AsyncFor):
            constructs["asyncFor"] += 1
        elif isinstance(node, ast.While):
            constructs["while"] += 1
        elif isinstance(node, ast.Try):
            constructs["try"] += 1
        elif isinstance(node, ast.ExceptHandler):
            constructs["except"] += 1
        elif isinstance(node, ast.With):
            constructs["with"] += 1
        elif isinstance(node, ast.AsyncWith):
            constructs["asyncWith"] += 1
        elif isinstance(node, ast.Return):
            constructs["return"] += 1
        elif isinstance(node, ast.Raise):
            constructs["raise"] += 1
        elif isinstance(node, ast.Lambda):
            constructs["lambda"] += 1

        def add_relation(
            kind: str,
            target: str,
            relation_node: ast.AST,
            call_safety: dict[str, bool] | None = None,
            resolution: str = "unresolved",
        ) -> None:
            nonlocal truncated
            if len(relations) >= MAX_PYTHON_AST_RELATIONS_PER_FILE:
                truncated = True
                return
            relation: dict[str, object] = {
                "kind": kind,
                "from": owner,
                "to": target[:200],
                "startLine": _node_line(relation_node),
                "resolved": resolution == "resolved",
                "resolution": resolution,
            }
            if call_safety is not None:
                relation["callSafety"] = call_safety
            relations.append(relation)

        next_owner = owner
        if isinstance(node, ast.ClassDef):
            qualified = node.name if owner == "<module>" else f"{owner}.{node.name}"
            if len(symbols) < MAX_PYTHON_AST_SYMBOLS_PER_FILE:
                symbols.append(_symbol(
                    source=source,
                    name=node.name,
                    kind="class",
                    qualified_name=qualified,
                    node=node,
                    parameter_count=None,
                    decorator_count=len(node.decorator_list),
                    cyclomatic_complexity=None,
                ))
            else:
                truncated = True
            constructs["decorator"] += len(node.decorator_list)
            add_relation("declares", qualified, node, resolution="resolved")
            next_owner = qualified
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            qualified = node.name if owner == "<module>" else f"{owner}.{node.name}"
            function_complexity, _function_nesting = _function_metrics(node)
            if len(symbols) < MAX_PYTHON_AST_SYMBOLS_PER_FILE:
                symbols.append(_symbol(
                    source=source,
                    name=node.name,
                    kind="async_function" if isinstance(node, ast.AsyncFunctionDef) else "function",
                    qualified_name=qualified,
                    node=node,
                    parameter_count=_parameter_count(node),
                    decorator_count=len(node.decorator_list),
                    cyclomatic_complexity=function_complexity,
                ))
            else:
                truncated = True
            constructs["decorator"] += len(node.decorator_list)
            add_relation("declares", qualified, node, resolution="resolved")
            next_owner = qualified

        if isinstance(node, ast.Import):
            for alias in node.names:
                add_relation("imports", alias.name, node, resolution="partially_resolved")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or "."
            for alias in node.names:
                add_relation(
                    "from_imports",
                    f"{module}:{alias.name}",
                    node,
                    resolution="partially_resolved",
                )
        elif isinstance(node, ast.Assign):
            is_all_assignment = any(
                isinstance(target, ast.Name) and target.id == "__all__"
                for target in node.targets
            )
            if is_all_assignment and isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                for member in node.value.elts:
                    if isinstance(member, ast.Constant) and isinstance(member.value, str):
                        add_relation("exports", member.value, node, resolution="resolved")
        elif isinstance(node, ast.Call):
            target = _identifier(node.func)
            if target:
                shell_true = any(
                    keyword.arg == "shell"
                    and isinstance(keyword.value, ast.Constant)
                    and keyword.value.value is True
                    for keyword in node.keywords
                )
                command_is_constant = bool(
                    node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                )
                add_relation(
                    "calls",
                    target,
                    node,
                    {
                        "shellTrue": shell_true,
                        "commandIsConstant": command_is_constant,
                    },
                )

        next_depth = depth + 1 if _is_nesting_construct(node) else depth
        children = list(ast.iter_child_nodes(node))
        for child in reversed(children):
            stack.append((child, next_depth, next_owner))

    result["cyclomaticComplexity"] = complexity
    result["maxNesting"] = maximum_nesting
    result["metricPrecision"] = {
        "physicalLines": "exact_under_model",
        "codeLines": "exact_under_model" if result["codeLines"] is not None else "unknown",
        "cyclomaticComplexity": "exact_under_model",
        "maxNesting": "exact_under_model",
    }
    result["symbols"] = symbols
    result["relations"] = relations
    result["truncated"] = truncated
    return result


def analyze_python_sources(files: Iterable[Mapping[str, object]]) -> dict[str, object]:
    """Analyze supplied Python source text within strict resource bounds.

    ``ValueError`` represents an invalid internal request. Syntax errors in a
    valid, bounded file are represented in that file's result so sibling files
    remain analyzable.
    """
    provided = list(files)
    if not provided or len(provided) > MAX_PYTHON_AST_FILES:
        raise ValueError("invalid_source_file_count")
    sources = [_validated_source(value) for value in provided]
    if sum(source["byteLength"] for source in sources) > MAX_PYTHON_AST_TOTAL_BYTES:
        raise ValueError("source_batch_too_large")
    results = [_analyze_source(source) for source in sources]
    return {
        "version": PYTHON_AST_VERSION,
        "files": results,
        "limits": {
            "maxFiles": MAX_PYTHON_AST_FILES,
            "maxFileBytes": MAX_PYTHON_AST_FILE_BYTES,
            "maxTotalBytes": MAX_PYTHON_AST_TOTAL_BYTES,
            "maxDepth": MAX_PYTHON_AST_DEPTH,
            "maxSymbolsPerFile": MAX_PYTHON_AST_SYMBOLS_PER_FILE,
            "maxRelationsPerFile": MAX_PYTHON_AST_RELATIONS_PER_FILE,
        },
    }
