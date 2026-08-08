#!/usr/bin/env python3
"""Fixture generator for the runtime/ canonical-ABI test ports.

Runs the *reference implementation* of the canonical ABI
(third_party/component-model/design/mvp/canonical-abi/definitions.py) and
records expected values as JSON, so the TypeScript port in runtime/src/cabi/
is tested differentially against the executable spec.

Regenerate with:
    cd runtime && deno task gen-fixtures      # or:
    python3 runtime/tests/fixtures/generate.py

Outputs (checked in, deterministic):
    sizes_flatten.json    alignment/elem_size/flatten_type per type, i32+i64
    functype_flatten.json flatten_functype for sync/async lift/lower
    strings.json          string lift bytes + lowering expectations

Notes:
  - definitions.DETERMINISTIC_PROFILE is set True (NaN canonicalization),
    matching run_tests.py and the only profile implementable in JS.
  - The `Heap` realloc mock is copied verbatim in behavior from
    run_tests.py::Heap (do-not-edit third_party rule); the TS twin lives in
    runtime/tests/support/heap.ts. String-lowering fixtures are only valid
    against an allocator with exactly this behavior.
  - String lowering expectations are generated with source provenance
    (s, 'utf16', <utf-16 code unit count>): a JS host string *is* a UTF-16
    code-unit sequence, so the TS port always lowers through the reference's
    utf16-source paths. See runtime/README.md ("provenance-free lowering").
"""

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CANONICAL_ABI_DIR = os.path.normpath(
    os.path.join(
        HERE, "..", "..", "..",
        "third_party", "component-model", "design", "mvp", "canonical-abi",
    )
)
sys.path.insert(0, CANONICAL_ABI_DIR)

import definitions  # noqa: E402
from definitions import (  # noqa: E402
    BoolType, BorrowType, CanonicalOptions, CharType, ComponentInstance,
    EnumType, ErrorContextType, F32Type, F64Type, FieldType, FlagsType,
    FuncType, FutureType, LiftLowerContext, ListType, MapType, MemInst,
    OptionType, OwnType, RecordType, ResourceType, ResultType, S8Type,
    S16Type, S32Type, S64Type, StreamType, StringType, Store, TupleType,
    U8Type, U16Type, U32Type, U64Type, VariantType, CaseType,
    alignment, elem_size, flatten_functype, flatten_type, align_to,
    store_string_into_range, utf16_tag, trap,
)

definitions.DETERMINISTIC_PROFILE = True


# --- Heap mock (behavioral copy of run_tests.py::Heap; see module docstring)

class Heap:
    def __init__(self, arg):
        self.memory = bytearray(arg)
        self.last_alloc = 0
        self.num_realloc_calls = 0

    def realloc(self, args):
        self.num_realloc_calls += 1
        original_ptr, original_size, alignment_, new_size = args
        if original_ptr != 0 and new_size < original_size:
            return [align_to(original_ptr, alignment_)]
        ret = align_to(self.last_alloc, alignment_)
        self.last_alloc = ret + new_size
        if self.last_alloc > len(self.memory):
            trap()
        self.memory[ret: ret + original_size] = \
            self.memory[original_ptr: original_ptr + original_size]
        return [ret]


# --- type DSL (mirrored by runtime/tests/support/typedsl.ts)

_PRIMS = {
    "bool": BoolType, "u8": U8Type, "s8": S8Type, "u16": U16Type,
    "s16": S16Type, "u32": U32Type, "s32": S32Type, "u64": U64Type,
    "s64": S64Type, "f32": F32Type, "f64": F64Type, "char": CharType,
    "string": StringType,
}

_dummy_rt = ResourceType(ComponentInstance(Store()))


def build_type(dsl):
    if isinstance(dsl, str):
        if dsl in _PRIMS:
            return _PRIMS[dsl]()
        if dsl == "error-context":
            return ErrorContextType()
        raise ValueError(f"unknown prim {dsl}")
    assert isinstance(dsl, dict) and len([k for k in dsl if k != "length"]) == 1
    if "list" in dsl:
        return ListType(build_type(dsl["list"]), dsl.get("length"))
    if "record" in dsl:
        return RecordType([FieldType(l, build_type(t)) for l, t in dsl["record"]])
    if "tuple" in dsl:
        return TupleType([build_type(t) for t in dsl["tuple"]])
    if "variant" in dsl:
        return VariantType(
            [CaseType(l, None if t is None else build_type(t))
             for l, t in dsl["variant"]])
    if "enum" in dsl:
        return EnumType(list(dsl["enum"]))
    if "enum-n" in dsl:
        return EnumType([f"c{i}" for i in range(dsl["enum-n"])])
    if "option" in dsl:
        return OptionType(build_type(dsl["option"]))
    if "result" in dsl:
        ok, err = dsl["result"]
        return ResultType(None if ok is None else build_type(ok),
                          None if err is None else build_type(err))
    if "map" in dsl:
        k, v = dsl["map"]
        return MapType(build_type(k), build_type(v))
    if "flags" in dsl:
        return FlagsType(list(dsl["flags"]))
    if "flags-n" in dsl:
        return FlagsType([f"f{i}" for i in range(dsl["flags-n"])])
    if "own" in dsl:
        return OwnType(_dummy_rt)
    if "borrow" in dsl:
        return BorrowType(_dummy_rt)
    if "stream" in dsl:
        t = dsl["stream"]
        return StreamType(None if t is None else build_type(t))
    if "future" in dsl:
        t = dsl["future"]
        return FutureType(None if t is None else build_type(t))
    raise ValueError(f"unknown type dsl {dsl}")


def mk_opts(addr_type="i32", async_=False, callback=False):
    opts = CanonicalOptions()
    opts.memory = MemInst(bytearray(), addr_type)
    opts.string_encoding = "utf8"
    opts.realloc = None
    opts.post_return = None
    opts.sync_task_return = False
    opts.async_ = async_
    opts.callback = (lambda *a: None) if callback else None
    return opts


# --- sizes_flatten.json

SIZE_TYPES = [
    "bool", "u8", "s8", "u16", "s16", "u32", "s32", "u64", "s64",
    "f32", "f64", "char", "string", "error-context",
    {"own": None}, {"borrow": None},
    {"stream": "u8"}, {"stream": None}, {"future": "f64"}, {"future": None},
    {"list": "u8"}, {"list": "string"}, {"list": "u8", "length": 3},
    {"list": "u64", "length": 2}, {"list": {"list": "u16"}, "length": 2},
    {"record": [["x", "u8"], ["y", "u16"], ["z", "u32"]]},
    {"record": [["a", "u8"], ["b", "u64"], ["c", "u8"]]},
    {"record": [["a", "u8"], ["b", "string"], ["c", "u8"]]},
    {"tuple": ["u8"]},
    {"tuple": ["u16", "u8"]},
    {"tuple": [{"tuple": ["u16", "u8"]}, "u8"]},
    {"tuple": ["u8", "u16", "u8", "u32"]},
    {"variant": [["x", "u8"], ["y", "f32"], ["z", None]]},
    {"variant": [["w", "u8"]]},
    {"variant": [["a", "u64"], ["b", "f64"], ["c", "f32"]]},
    {"variant": [["a", {"tuple": ["u8", "u8"]}], ["b", "u64"]]},
    {"enum": ["a", "b"]},
    {"enum-n": 1}, {"enum-n": 256}, {"enum-n": 257},
    {"enum-n": 65536}, {"enum-n": 65537},
    {"option": "f32"}, {"option": "string"}, {"option": {"option": "u8"}},
    {"result": ["u8", "u32"]}, {"result": [None, None]},
    {"result": ["string", None]},
    {"map": ["u8", "u16"]}, {"map": ["string", {"list": "u8"}]},
    {"flags": ["a", "b"]},
    {"flags-n": 1}, {"flags-n": 8}, {"flags-n": 9}, {"flags-n": 16},
    {"flags-n": 17}, {"flags-n": 32},
]


def gen_sizes_flatten():
    entries = []
    for dsl in SIZE_TYPES:
        t = build_type(dsl)
        entry = {
            "type": dsl,
            "align": {at: alignment(t, at) for at in ("i32", "i64")},
            "size": {at: elem_size(t, at) for at in ("i32", "i64")},
            "flat": {at: flatten_type(t, mk_opts(at)) for at in ("i32", "i64")},
        }
        entries.append(entry)
    return entries


# --- functype_flatten.json

FUNC_CASES = [
    # (name, params dsl, results dsl, addr_type, async, callback)
    ("prims", ["u8", "f32", "f64"], [], "i32", False, False),
    ("prims->f32", ["u8", "f32", "f64"], ["f32"], "i32", False, False),
    ("prims->u8", ["u8", "f32", "f64"], ["u8"], "i32", False, False),
    ("prims->tuple1", ["u8", "f32", "f64"], [{"tuple": ["f32"]}], "i32", False, False),
    ("prims->tuple2", ["u8", "f32", "f64"], [{"tuple": ["f32", "f32"]}], "i32", False, False),
    ("16 params", ["u8"] * 16, [], "i32", False, False),
    ("17 params", ["u8"] * 17, [], "i32", False, False),
    ("17 params (i64)", ["u8"] * 17, [], "i64", False, False),
    ("17 params -> tuple2", ["u8"] * 17, [{"tuple": ["u8", "u8"]}], "i32", False, False),
    ("17 params -> tuple2 (i64)", ["u8"] * 17, [{"tuple": ["u8", "u8"]}], "i64", False, False),
    ("string->string", ["string"], ["string"], "i32", False, False),
    ("string->string (i64)", ["string"], ["string"], "i64", False, False),
    ("u64s", ["u64", "s64"], ["u64"], "i32", False, False),
    ("async none", ["u8"], [], "i32", True, False),
    ("async cb none", ["u8"], [], "i32", True, True),
    ("async result", ["u8"], ["u8"], "i32", True, False),
    ("async cb result", ["u8"], ["u8"], "i32", True, True),
    ("async 4 params", ["u8"] * 4, ["u8"], "i32", True, False),
    ("async 5 params", ["u8"] * 5, ["u8"], "i32", True, False),
    ("async 5 params (i64)", ["u8"] * 5, ["u8"], "i64", True, True),
    ("async string->string", ["string"], ["string"], "i32", True, True),
]


def gen_functype_flatten():
    entries = []
    for name, params, results, addr_type, async_, callback in FUNC_CASES:
        ft = FuncType([build_type(p) for p in params],
                      [build_type(r) for r in results],
                      async_=async_)
        entry = {
            "name": name,
            "params": params,
            "results": results,
            "addrType": addr_type,
            "async": async_,
            "callback": callback,
        }
        for context in ("lift", "lower"):
            opts = mk_opts(addr_type, async_, callback)
            got = flatten_functype(opts, ft, context)
            entry[context] = {"params": got.params, "results": got.results}
        entries.append(entry)
    return entries


# --- strings.json

# Test corpus: fun_strings from run_tests.py (provenance: spec test suite),
# plus extra edge strings (astral plane, boundaries). All well-formed;
# lone-surrogate handling is JS-specific and tested in TS directly.
FUN_STRINGS = [
    "", "a", "hi", "\x00", "a\x00b", "\x80", "\x80b", "ab\xefc",
    "\u01ffy", "xy\u01ff", "a\ud7ffb", "a\u02ff\u03ff\u04ffbc",
    "\uf123", "\uf123\uf123abc", "abcdef\uf123",
]
EXTRA_STRINGS = [
    "\xff", "\u0100", "\ue000", "\ufffd", "\U0010ffff",
    "\U0001d11e", "x\U0001f600y", "\U0001f600" * 3,
    "caf\xe9 costs \u20ac5", "mixed \u01ff \U0001f600 ascii",
]
ALL_STRINGS = FUN_STRINGS + EXTRA_STRINGS

ENCODINGS = ["utf8", "utf16", "latin1+utf16"]


def utf16_len(s):
    return len(s.encode("utf-16-le")) // 2


def gen_strings():
    entries = []
    for s in ALL_STRINGS:
        units16 = utf16_len(s)
        entry = {
            "codePoints": [ord(c) for c in s],
            "utf16Units": units16,
            "lifts": [],
            "lowers": [],
        }
        # Lift inputs: guest memory bytes per source encoding.
        for addr_type in ("i32", "i64"):
            tag = utf16_tag(addr_type)
            entry["lifts"].append({
                "srcEncoding": "utf8", "addrType": addr_type,
                "bytesHex": s.encode("utf-8").hex(),
                "taggedCodeUnits": str(len(s.encode("utf-8"))),
            })
            entry["lifts"].append({
                "srcEncoding": "utf16", "addrType": addr_type,
                "bytesHex": s.encode("utf-16-le").hex(),
                "taggedCodeUnits": str(units16),
            })
            try:
                latin1 = s.encode("latin-1")
                entry["lifts"].append({
                    "srcEncoding": "latin1+utf16", "addrType": addr_type,
                    "bytesHex": latin1.hex(),
                    "taggedCodeUnits": str(len(latin1)),
                })
            except UnicodeEncodeError:
                pass
            entry["lifts"].append({
                "srcEncoding": "latin1+utf16", "addrType": addr_type,
                "bytesHex": s.encode("utf-16-le").hex(),
                "taggedCodeUnits": str(units16 | tag),
            })
        # Lowering expectations: JS-string source == utf16 provenance.
        for addr_type in ("i32", "i64"):
            tag = utf16_tag(addr_type)
            for dst in ENCODINGS:
                heap_size = 64 + 8 * units16
                heap = Heap(heap_size)
                opts = CanonicalOptions()
                opts.memory = MemInst(heap.memory, addr_type)
                opts.string_encoding = dst
                opts.realloc = heap.realloc
                opts.post_return = None
                opts.async_ = False
                opts.callback = None
                cx = LiftLowerContext(opts, ComponentInstance(Store()))
                ptr, tagged = store_string_into_range(
                    cx, (s, "utf16", units16))
                if dst == "utf8":
                    byte_len = tagged
                elif dst == "utf16":
                    byte_len = 2 * tagged
                else:
                    byte_len = 2 * (tagged ^ tag) if tagged & tag else tagged
                entry["lowers"].append({
                    "dstEncoding": dst,
                    "addrType": addr_type,
                    "heapSize": heap_size,
                    "ptr": ptr,
                    "taggedCodeUnits": str(tagged),
                    "bytesHex": bytes(heap.memory[ptr: ptr + byte_len]).hex(),
                    "lastAlloc": heap.last_alloc,
                    "reallocCalls": heap.num_realloc_calls,
                })
        entries.append(entry)
    return entries


def write(name, data):
    path = os.path.join(HERE, name)
    doc = {
        "_meta": {
            "generator": "runtime/tests/fixtures/generate.py",
            "source": "third_party/component-model/design/mvp/canonical-abi/definitions.py",
            "deterministicProfile": True,
        },
        "entries": data,
    }
    with open(path, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True, ensure_ascii=True)
        f.write("\n")
    print(f"wrote {name}: {len(data)} entries")


def main():
    write("sizes_flatten.json", gen_sizes_flatten())
    write("functype_flatten.json", gen_functype_flatten())
    write("strings.json", gen_strings())


if __name__ == "__main__":
    main()
