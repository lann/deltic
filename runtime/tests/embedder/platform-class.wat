;; "Zero-glue platform class" fixture for the embedder conventions layer
;; (contracts/embedder-api.md §"Resources", §"Value mapping (normative)",
;; §"Error model", §"Naming and casing" — see platform_class_test.ts for the
;; pins this exercises). Models a WIT interface whose two resources are bound
;; DIRECTLY to native web platform classes (`URLSearchParams`, `TextDecoder`)
;; with no host-side wrapper:
;;
;;   resource params {
;;     constructor(init: string);
;;     append: func(name: string, value: string);
;;     has: func(name: string) -> bool;
;;     to-string: func() -> string;          // kebab->camel: toString
;;     get: func(name: string) -> option<string>;
;;     size: func() -> u32;                  // a GETTER on the native class,
;;                                            // not a method (deliberate limit)
;;   }
;;   record decoder-options { fatal: bool }
;;   resource decoder {
;;     constructor(label: string, options: decoder-options);
;;     decode: func(data: list<u8>) -> result<string, string>;  // result-typed
;;                                            // on purpose: native throws are
;;                                            // unbranded -> trap, not `err`
;;   }
;;
;; Guest exports are thin lower/lift trampolines, one per probe, following
;; imports.wat / host-result-payload.wat / host-borrow.wat's style: own vs
;; borrow are both plain i32 handle-table indices at the core level (no
;; `canon resource.drop` calls here — nothing in the pins depends on
;; disposal, so the fixture stays minimal).
;;
;; Canonical ABI bookkeeping (definitions.py, this repo's tie-breaker):
;;   - MAX_FLAT_RESULTS = 1: any multi-value result (string, option<string>,
;;     result<string,string>) spills to a return pointer. For an *import*
;;     call (`canon lower`), that pointer is an extra trailing i32 PARAM the
;;     guest must supply itself (flatten_functype's 'lower' arm). For an
;;     *export* (`canon lift`), the guest's core function simply RETURNS the
;;     i32 address where it already wrote the tuple ('lift' arm) — so
;;     `roundtrip`'s export result reuses the exact scratch address
;;     `to-string`'s import call wrote into.
;;   - `option<T>` desugars to `variant { none, some(T) }` (despecialize):
;;     case 0 = none, case 1 = some. `result<T, E>` desugars to
;;     `variant { ok(T), error(E) }`: case 0 = ok, case 1 = error.
;;   - store_variant: 1-byte discriminant (2 cases), then the payload at the
;;     max case alignment (4, since the payload is a string (ptr,len) pair) —
;;     same layout host-result-payload.wat documents.
;;
;; Regenerate: wasm-tools parse platform-class.wat -o platform-class.wasm
(component
  (import "test:platform/web" (instance $api
    (export "params" (type $Params (sub resource)))
    (export "[constructor]params"
      (func (param "init" string) (result (own $Params))))
    (export "[method]params.append"
      (func (param "self" (borrow $Params)) (param "name" string) (param "value" string)))
    (export "[method]params.has"
      (func (param "self" (borrow $Params)) (param "name" string) (result bool)))
    (export "[method]params.to-string"
      (func (param "self" (borrow $Params)) (result string)))
    (export "[method]params.get"
      (func (param "self" (borrow $Params)) (param "name" string) (result (option string))))
    (export "[method]params.size"
      (func (param "self" (borrow $Params)) (result u32)))
    (export "decoder" (type $Decoder (sub resource)))
    ;; The options record must be a NAMED type export of this instance:
    ;; wasmparser's import validation (`all_valtypes_named_in_func`) rejects
    ;; anonymous records/variants in imported function signatures.
    (type $optsDef (record (field "fatal" bool)))
    (export "decoder-options" (type $Opts (eq $optsDef)))
    (export "[constructor]decoder"
      (func (param "label" string) (param "options" $Opts)
            (result (own $Decoder))))
    (export "[method]decoder.decode"
      (func (param "self" (borrow $Decoder)) (param "data" (list u8))
            (result (result string (error string)))))))

  (alias export $api "params" (type $Params))
  (alias export $api "decoder" (type $Decoder))
  (alias export $api "[constructor]params" (func $ctorParams))
  (alias export $api "[method]params.append" (func $append))
  (alias export $api "[method]params.has" (func $has))
  (alias export $api "[method]params.to-string" (func $toString))
  (alias export $api "[method]params.get" (func $get))
  (alias export $api "[method]params.size" (func $size))
  (alias export $api "[constructor]decoder" (func $ctorDecoder))
  (alias export $api "[method]decoder.decode" (func $decode))

  (core module $Mem
    (memory (export "mem") 1)
    ;; The fixed-address label the decoder probes construct with; harmless
    ;; content ("utf-8" is also a valid, if odd, URLSearchParams init string
    ;; for probe-size, which does not care about its params' contents).
    (data (i32.const 64) "utf-8")
    (global $next (mut i32) (i32.const 4096))
    (func (export "realloc")
      (param $old i32) (param $oldsz i32) (param $align i32) (param $newsz i32)
      (result i32)
      (local $ret i32)
      (global.set $next
        (i32.and (i32.add (global.get $next) (i32.sub (local.get $align) (i32.const 1)))
                 (i32.xor (i32.sub (local.get $align) (i32.const 1)) (i32.const -1))))
      (local.set $ret (global.get $next))
      (global.set $next (i32.add (global.get $next) (local.get $newsz)))
      (local.get $ret)))
  (core instance $mem (instantiate $Mem))

  ;; Args-only lowerings: strings are read from guest memory but nothing is
  ;; written back, so no realloc capability is needed.
  (canon lower (func $ctorParams) (memory $mem "mem") (core func $ctorParams'))
  (canon lower (func $append) (memory $mem "mem") (core func $append'))
  (canon lower (func $has) (memory $mem "mem") (core func $has'))
  (canon lower (func $size) (core func $size'))
  (canon lower (func $ctorDecoder) (memory $mem "mem") (core func $ctorDecoder'))
  ;; Result-bearing lowerings: the host's string payload must be written into
  ;; guest memory, so these need realloc too.
  (canon lower (func $toString)
    (memory $mem "mem") (realloc (func $mem "realloc")) (core func $toString'))
  (canon lower (func $get)
    (memory $mem "mem") (realloc (func $mem "realloc")) (core func $get'))
  (canon lower (func $decode)
    (memory $mem "mem") (realloc (func $mem "realloc")) (core func $decode'))

  (core module $M
    (import "" "ctorParams" (func $ctorParams (param i32 i32) (result i32)))
    (import "" "append" (func $append (param i32 i32 i32 i32 i32)))
    (import "" "has" (func $has (param i32 i32 i32) (result i32)))
    (import "" "toString" (func $toString (param i32 i32)))
    (import "" "get" (func $get (param i32 i32 i32 i32)))
    (import "" "size" (func $size (param i32) (result i32)))
    (import "" "ctorDecoder" (func $ctorDecoder (param i32 i32 i32) (result i32)))
    (import "" "decode" (func $decode (param i32 i32 i32 i32)))
    (import "mem" "mem" (memory 1))

    ;; Scratch addresses for spilled (>1 flat value) results. Disjoint from
    ;; each other, from the "utf-8" label at 64, and from the realloc bump
    ;; region starting at 4096 where every argument string/list the runtime
    ;; copies in for us actually lands.
    ;;   0  : to-string's / roundtrip's string tuple (ptr, len)      [8B]
    ;;   16 : get's option<string> (disc, ptr, len)                 [12B]
    ;;   32 : decode's result<string,string> (disc, ptr, len)       [12B]

    ;; roundtrip(init, name, value) -> string
    ;;   construct(init); append(name, value); return to-string()
    (func (export "roundtrip")
      (param $ip i32) (param $il i32)
      (param $np i32) (param $nl i32)
      (param $vp i32) (param $vl i32)
      (result i32)
      (local $h i32)
      (local.set $h (call $ctorParams (local.get $ip) (local.get $il)))
      (call $append (local.get $h) (local.get $np) (local.get $nl) (local.get $vp) (local.get $vl))
      (call $toString (local.get $h) (i32.const 0))
      (i32.const 0))

    ;; probe-has(init, name) -> bool
    (func (export "probe-has")
      (param $ip i32) (param $il i32) (param $np i32) (param $nl i32)
      (result i32)
      (local $h i32)
      (local.set $h (call $ctorParams (local.get $ip) (local.get $il)))
      (call $has (local.get $h) (local.get $np) (local.get $nl)))

    ;; probe-get(init, name) -> option<string>
    (func (export "probe-get")
      (param $ip i32) (param $il i32) (param $np i32) (param $nl i32)
      (result i32)
      (local $h i32)
      (local.set $h (call $ctorParams (local.get $ip) (local.get $il)))
      (call $get (local.get $h) (local.get $np) (local.get $nl) (i32.const 16))
      (i32.const 16))

    ;; probe-size() -> u32 (constructs a fixed instance; the getter-vs-method
    ;; limit is what this probe is for, not the constructor argument)
    (func (export "probe-size") (result i32)
      (local $h i32)
      (local.set $h (call $ctorParams (i32.const 64) (i32.const 5)))
      (call $size (local.get $h)))

    ;; probe-decode(fatal, data) -> result<string, string>
    (func (export "probe-decode")
      (param $fatal i32) (param $dp i32) (param $dl i32)
      (result i32)
      (local $h i32)
      (local.set $h (call $ctorDecoder (i32.const 64) (i32.const 5) (local.get $fatal)))
      (call $decode (local.get $h) (local.get $dp) (local.get $dl) (i32.const 32))
      (i32.const 32)))

  (core instance $i (instantiate $M
    (with "" (instance
      (export "ctorParams" (func $ctorParams'))
      (export "append" (func $append'))
      (export "has" (func $has'))
      (export "toString" (func $toString'))
      (export "get" (func $get'))
      (export "size" (func $size'))
      (export "ctorDecoder" (func $ctorDecoder'))
      (export "decode" (func $decode'))))
    (with "mem" (instance $mem))))

  (func (export "roundtrip")
    (param "init" string) (param "name" string) (param "value" string) (result string)
    (canon lift (core func $i "roundtrip") (memory $mem "mem") (realloc (func $mem "realloc"))))
  (func (export "probe-has")
    (param "init" string) (param "name" string) (result bool)
    (canon lift (core func $i "probe-has") (memory $mem "mem") (realloc (func $mem "realloc"))))
  (func (export "probe-get")
    (param "init" string) (param "name" string) (result (option string))
    (canon lift (core func $i "probe-get") (memory $mem "mem") (realloc (func $mem "realloc"))))
  (func (export "probe-size") (result u32)
    (canon lift (core func $i "probe-size")))
  (func (export "probe-decode")
    (param "fatal" bool) (param "data" (list u8)) (result (result string (error string)))
    (canon lift (core func $i "probe-decode") (memory $mem "mem") (realloc (func $mem "realloc")))))
