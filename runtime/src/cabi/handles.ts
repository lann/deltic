// Handle tables and resource handles (definitions.py `### Table State`,
// `### Resource State`, `canon resource.{new,drop,rep}`, and the
// own/borrow lift/lower functions).
//
// The Table and ResourceHandle mechanics are pure and ported fully. What is
// simplified here (pending the task machinery):
//   - canon_resource_* take the instance explicitly instead of reading
//     current_instance() from the running thread;
//   - canon_resource_drop invokes the dtor as a direct call, where the
//     reference routes it through store.lift/store.lower to get reentrance
//     gating (may_enter checks) — deferred with the scheduler.

import { assert_, trapIf } from "./trap.ts";
import type {
  ComponentInstanceLike,
  LiftLowerContext,
  SubtaskBorrowScope,
  TaskBorrowScope,
} from "./context.ts";
import type { BorrowType, OwnType, ResourceTypeInfo } from "./types.ts";

export class Table<T> {
  static readonly MAX_LENGTH = 2 ** 28 - 1;

  array: (T | null)[] = [null];
  free: number[] = [];

  get(i: number): T {
    trapIf(i >= this.array.length, "table index out of range");
    trapIf(this.array[i] === null, "table entry empty");
    return this.array[i]!;
  }

  add(e: T): number {
    let i: number;
    if (this.free.length > 0) {
      i = this.free.pop()!;
      assert_(this.array[i] === null);
      this.array[i] = e;
    } else {
      i = this.array.length;
      trapIf(i > Table.MAX_LENGTH, "table full");
      this.array.push(e);
    }
    return i;
  }

  remove(i: number): T {
    const e = this.get(i);
    this.array[i] = null;
    this.free.push(i);
    return e;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const e of this.array) {
      if (e !== null) yield e;
    }
  }
}

export class ResourceHandle {
  numLends = 0;

  constructor(
    public rt: ResourceTypeInfo,
    public rep: number,
    public own: boolean,
    public borrowScope: TaskBorrowScope | null = null,
  ) {}
}

// ---------------------------------------------------------------------------
// own/borrow lift & lower (called from load/store/lift/lower dispatchers)
// ---------------------------------------------------------------------------

function requireInst(cx: LiftLowerContext): ComponentInstanceLike {
  assert_(cx.inst !== null, "context requires a component instance");
  return cx.inst;
}

export function liftOwn(
  cx: LiftLowerContext,
  i: number,
  t: OwnType,
): number {
  const h = requireInst(cx).handles.remove(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== t.rt, "resource type mismatch");
  trapIf(rh.numLends !== 0, "handle still lent out");
  trapIf(!rh.own, "expected own handle");
  return rh.rep;
}

export function liftBorrow(
  cx: LiftLowerContext,
  i: number,
  t: BorrowType,
): number {
  const scope = cx.borrowScope as SubtaskBorrowScope | null;
  assert_(
    scope !== null && typeof scope.addLender === "function",
    "lifting a borrow requires a subtask borrow scope",
  );
  const h = requireInst(cx).handles.get(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== t.rt, "resource type mismatch");
  scope!.addLender(rh);
  return rh.rep;
}

export function lowerOwn(
  cx: LiftLowerContext,
  rep: number,
  t: OwnType,
): number {
  const h = new ResourceHandle(t.rt, rep, true);
  return requireInst(cx).handles.add(h);
}

export function lowerBorrow(
  cx: LiftLowerContext,
  rep: number,
  t: BorrowType,
): number {
  const scope = cx.borrowScope as TaskBorrowScope | null;
  assert_(
    scope !== null && typeof scope.numBorrows === "number",
    "lowering a borrow requires a task borrow scope",
  );
  if (cx.inst !== null && cx.inst === (t.rt.impl as unknown)) {
    return rep;
  }
  const h = new ResourceHandle(t.rt, rep, false, scope);
  scope!.numBorrows += 1;
  return requireInst(cx).handles.add(h);
}

// ---------------------------------------------------------------------------
// canon resource.new / resource.drop / resource.rep
// (instance passed explicitly; see module comment)
// ---------------------------------------------------------------------------

export function canonResourceNew(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  rep: number,
): number {
  trapIf(!inst.mayLeave, "may_leave violation");
  const h = new ResourceHandle(rt, rep, true);
  return inst.handles.add(h);
}

export function canonResourceDrop(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  i: number,
): void {
  trapIf(!inst.mayLeave, "may_leave violation");
  const h = inst.handles.remove(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== rt, "resource type mismatch");
  trapIf(rh.numLends !== 0, "handle still lent out");
  if (rh.own) {
    assert_(rh.borrowScope === null);
    // Reference: dtor invoked through store.lift/store.lower so that
    // may_enter gating applies (cross-instance call). Deferred; direct call.
    if (rt.dtor) rt.dtor(rh.rep);
  } else {
    assert_(rh.borrowScope !== null);
    rh.borrowScope!.numBorrows -= 1;
  }
}

export function canonResourceRep(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  i: number,
): number {
  const h = inst.handles.get(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== rt, "resource type mismatch");
  return rh.rep;
}
