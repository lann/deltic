//! Conversion of one parsed `.wast` file into JSON commands + artifact files.

use anyhow::{bail, Context, Result};
use wast::core::{AbstractHeapType, HeapType, NanPattern, V128Const, V128Pattern};
use wast::core::{WastArgCore, WastRetCore};
use wast::component::WastVal;
use wast::token::{Id, Span};
use wast::{QuoteWat, QuoteWatTest, Wast, WastArg, WastDirective, WastExecute, WastInvoke, WastRet, Wat};

use crate::json::{Action, Command, Kind, ModuleType, Value, WastJson};

/// Result of converting a single `.wast` file: the JSON document plus the
/// artifact files (`<stem>.<N>.wasm` / `.wat`) it references.
pub struct Converted {
    pub json: WastJson,
    pub artifacts: Vec<(String, Vec<u8>)>,
}

pub fn convert_wast(source_rel: &str, stem: &str, text: &str) -> Result<Converted> {
    let mut lexer = wast::lexer::Lexer::new(text);
    lexer.allow_confusing_unicode(true);
    let buf = wast::parser::ParseBuffer::new_with_lexer(lexer)
        .map_err(|e| pretty(e, source_rel, text))?;
    let wast: Wast = wast::parser::parse(&buf).map_err(|e| pretty(e, source_rel, text))?;

    let mut cx = Converter {
        text,
        stem,
        next_idx: 0,
        commands: Vec::new(),
        artifacts: Vec::new(),
    };
    for directive in wast.directives {
        let line = cx.line_of(directive.span());
        cx.directive(directive)
            .with_context(|| format!("{source_rel}:{line}: failed to convert directive"))?;
    }
    Ok(Converted {
        json: WastJson {
            source_filename: source_rel.to_string(),
            commands: cx.commands,
        },
        artifacts: cx.artifacts,
    })
}

fn pretty(mut e: wast::Error, path: &str, text: &str) -> anyhow::Error {
    e.set_path(std::path::Path::new(path));
    e.set_text(text);
    anyhow::anyhow!("{e}")
}

struct Converter<'a> {
    text: &'a str,
    stem: &'a str,
    next_idx: usize,
    commands: Vec<Command>,
    artifacts: Vec<(String, Vec<u8>)>,
}

/// An extracted module/component artifact, ready to reference from a command.
struct Artifact {
    name: Option<String>,
    filename: String,
    module_type: ModuleType,
    kind: Kind,
}

impl<'a> Converter<'a> {
    fn line_of(&self, span: Span) -> usize {
        span.linecol_in(self.text).0 + 1
    }

    fn directive(&mut self, directive: WastDirective<'a>) -> Result<()> {
        let line = self.line_of(directive.span());
        match directive {
            WastDirective::Module(qw) => {
                let a = self.emit_quote_wat(qw, false)?;
                self.commands.push(Command::Module {
                    line,
                    name: a.name,
                    filename: a.filename,
                    module_type: a.module_type,
                    kind: a.kind,
                });
            }
            WastDirective::ModuleDefinition(qw) => {
                let a = self.emit_quote_wat(qw, false)?;
                self.commands.push(Command::ModuleDefinition {
                    line,
                    name: a.name,
                    filename: a.filename,
                    module_type: a.module_type,
                    kind: a.kind,
                });
            }
            WastDirective::ModuleInstance {
                instance, module, ..
            } => {
                self.commands.push(Command::ModuleInstance {
                    line,
                    instance: instance.map(id_name),
                    module: module.map(id_name),
                });
            }
            WastDirective::AssertMalformed { module, message, .. } => {
                let a = self.emit_quote_wat(module, true)?;
                self.commands.push(Command::AssertMalformed {
                    line,
                    filename: a.filename,
                    module_type: a.module_type,
                    kind: a.kind,
                    text: message.to_string(),
                });
            }
            WastDirective::AssertInvalid { module, message, .. } => {
                let a = self.emit_quote_wat(module, false)?;
                self.commands.push(Command::AssertInvalid {
                    line,
                    filename: a.filename,
                    module_type: a.module_type,
                    kind: a.kind,
                    text: message.to_string(),
                });
            }
            WastDirective::AssertMalformedCustom { .. } | WastDirective::AssertInvalidCustom { .. } => {
                bail!("assert_malformed_custom / assert_invalid_custom are not supported")
            }
            WastDirective::Register { name, module, .. } => {
                self.commands.push(Command::Register {
                    line,
                    as_: name.to_string(),
                    name: module.map(id_name),
                });
            }
            WastDirective::Invoke(invoke) => {
                let action = self.invoke_action(invoke)?;
                self.commands.push(Command::Action { line, action });
            }
            WastDirective::AssertTrap { exec, message, .. } => match exec {
                // `(assert_trap (component ...) "...")`: instantiation trap.
                WastExecute::Wat(wat) => {
                    let a = self.emit_wat(wat)?;
                    self.commands.push(Command::AssertUninstantiable {
                        line,
                        filename: a.filename,
                        module_type: a.module_type,
                        kind: a.kind,
                        text: message.to_string(),
                    });
                }
                exec => {
                    let action = self.execute_action(exec)?;
                    self.commands.push(Command::AssertTrap {
                        line,
                        action,
                        text: message.to_string(),
                    });
                }
            },
            WastDirective::AssertReturn { exec, results, .. } => {
                let action = self.execute_action(exec)?;
                let expected = results
                    .into_iter()
                    .map(|r| self.ret_value(r))
                    .collect::<Result<Vec<_>>>()?;
                self.commands.push(Command::AssertReturn {
                    line,
                    action,
                    expected,
                });
            }
            WastDirective::AssertExhaustion { call, message, .. } => {
                let action = self.invoke_action(call)?;
                self.commands.push(Command::AssertExhaustion {
                    line,
                    action,
                    text: message.to_string(),
                });
            }
            WastDirective::AssertUnlinkable { module, message, .. } => {
                let a = self.emit_wat(module)?;
                self.commands.push(Command::AssertUnlinkable {
                    line,
                    filename: a.filename,
                    module_type: a.module_type,
                    kind: a.kind,
                    text: message.to_string(),
                });
            }
            WastDirective::AssertException { exec, .. } => {
                let action = self.execute_action(exec)?;
                self.commands.push(Command::AssertException { line, action });
            }
            WastDirective::AssertSuspension { exec, message, .. } => {
                let action = self.execute_action(exec)?;
                self.commands.push(Command::AssertSuspension {
                    line,
                    action,
                    text: message.to_string(),
                });
            }
            WastDirective::Thread(_) | WastDirective::Wait { .. } => {
                bail!("thread/wait directives are not supported")
            }
        }
        Ok(())
    }

    /// Encode a module/component to an artifact file.
    ///
    /// `force_text_for_quote`: `assert_malformed` quote forms are always kept
    /// as text (malformedness must be judged from the source text, and the
    /// text generally cannot be encoded anyway). Everything else is encoded
    /// to binary, falling back to text only for quote forms that fail to
    /// parse.
    fn emit_quote_wat(&mut self, mut qw: QuoteWat<'a>, force_text_for_quote: bool) -> Result<Artifact> {
        let kind = match &qw {
            QuoteWat::Wat(Wat::Module(_)) | QuoteWat::QuoteModule(..) => Kind::Module,
            QuoteWat::Wat(Wat::Component(_)) | QuoteWat::QuoteComponent(..) => Kind::Component,
        };
        let name = qw.name().map(id_name);
        let is_quote = !matches!(qw, QuoteWat::Wat(_));

        if is_quote && force_text_for_quote {
            match qw.to_test().map_err(|e| pretty(e, "<quote>", self.text))? {
                QuoteWatTest::Text(t) => return Ok(self.push_artifact(name, ModuleType::Text, kind, t)),
                QuoteWatTest::Binary(_) => unreachable!("quote forms convert to text"),
            }
        }

        match qw.encode() {
            Ok(bytes) => Ok(self.push_artifact(name, ModuleType::Binary, kind, bytes)),
            Err(_) if is_quote => {
                // Quote form whose text does not parse: keep it as text so a
                // text-capable consumer could still run the assertion.
                match qw.to_test().map_err(|e| pretty(e, "<quote>", self.text))? {
                    QuoteWatTest::Text(t) => Ok(self.push_artifact(name, ModuleType::Text, kind, t)),
                    QuoteWatTest::Binary(_) => unreachable!("quote forms convert to text"),
                }
            }
            Err(e) => Err(pretty(e, "<module>", self.text)).context("failed to encode module"),
        }
    }

    fn emit_wat(&mut self, wat: Wat<'a>) -> Result<Artifact> {
        self.emit_quote_wat(QuoteWat::Wat(wat), false)
    }

    fn push_artifact(
        &mut self,
        name: Option<String>,
        module_type: ModuleType,
        kind: Kind,
        bytes: Vec<u8>,
    ) -> Artifact {
        let ext = match module_type {
            ModuleType::Binary => "wasm",
            ModuleType::Text => "wat",
        };
        let filename = format!("{}.{}.{}", self.stem, self.next_idx, ext);
        self.next_idx += 1;
        self.artifacts.push((filename.clone(), bytes));
        Artifact {
            name,
            filename,
            module_type,
            kind,
        }
    }

    fn execute_action(&mut self, exec: WastExecute<'a>) -> Result<Action> {
        match exec {
            WastExecute::Invoke(i) => self.invoke_action(i),
            WastExecute::Get { module, global, .. } => Ok(Action::Get {
                module: module.map(id_name),
                field: global.to_string(),
            }),
            WastExecute::Wat(_) => bail!("inline module in action position is not supported here"),
        }
    }

    fn invoke_action(&mut self, invoke: WastInvoke<'a>) -> Result<Action> {
        let args = invoke
            .args
            .into_iter()
            .map(|a| self.arg_value(a))
            .collect::<Result<Vec<_>>>()?;
        Ok(Action::Invoke {
            module: invoke.module.map(id_name),
            field: invoke.name.to_string(),
            args,
        })
    }

    fn arg_value(&self, arg: WastArg<'a>) -> Result<Value> {
        match arg {
            WastArg::Core(c) => core_arg_value(c),
            WastArg::Component(v) => component_value(v),
            _ => bail!("unsupported argument value"),
        }
    }

    fn ret_value(&self, ret: WastRet<'a>) -> Result<Value> {
        match ret {
            WastRet::Core(c) => core_ret_value(c),
            WastRet::Component(v) => component_value(v),
            _ => bail!("unsupported result value"),
        }
    }
}

fn id_name(id: Id<'_>) -> String {
    id.name().to_string()
}

// ---------------------------------------------------------------- values ---

fn core_arg_value(arg: WastArgCore<'_>) -> Result<Value> {
    use WastArgCore::*;
    Ok(match arg {
        I32(v) => Value::simple("i32", (v as u32).to_string()),
        I64(v) => Value::simple("i64", (v as u64).to_string()),
        F32(f) => Value::simple("f32", f.bits.to_string()),
        F64(f) => Value::simple("f64", f.bits.to_string()),
        V128(v) => v128_const_value(v),
        RefNull(ht) => Value::simple(heap_type_name(&ht)?, "null"),
        RefExtern(v) => Value::simple("externref", v.to_string()),
        RefHost(v) => Value::simple("hostref", v.to_string()),
    })
}

fn core_ret_value(ret: WastRetCore<'_>) -> Result<Value> {
    use WastRetCore::*;
    Ok(match ret {
        I32(v) => Value::simple("i32", (v as u32).to_string()),
        I64(v) => Value::simple("i64", (v as u64).to_string()),
        F32(f) => Value::simple("f32", nan_pattern_string(f, |f| f.bits.to_string())),
        F64(f) => Value::simple("f64", nan_pattern_string(f, |f| f.bits.to_string())),
        V128(v) => v128_pattern_value(v),
        RefNull(ht) => match ht {
            Some(ht) => Value::simple(heap_type_name(&ht)?, "null"),
            None => Value::simple("refnull", "null"),
        },
        RefExtern(v) => match v {
            Some(v) => Value::simple("externref", v.to_string()),
            None => Value::simple("externref", serde_json::Value::Null),
        },
        RefHost(v) => Value::simple("hostref", v.to_string()),
        RefFunc(_) => Value::simple("funcref", serde_json::Value::Null),
        RefAny => Value::simple("anyref", serde_json::Value::Null),
        RefEq => Value::simple("eqref", serde_json::Value::Null),
        RefArray => Value::simple("arrayref", serde_json::Value::Null),
        RefStruct => Value::simple("structref", serde_json::Value::Null),
        RefI31 | RefI31Shared => Value::simple("i31ref", serde_json::Value::Null),
        Either(alternatives) => {
            let vals = alternatives
                .into_iter()
                .map(core_ret_value)
                .collect::<Result<Vec<_>>>()?;
            Value::simple("either", serde_json::to_value(vals)?)
        }
    })
}

fn nan_pattern_string<T>(p: NanPattern<T>, fmt: impl Fn(T) -> String) -> String {
    match p {
        NanPattern::CanonicalNan => "nan:canonical".to_string(),
        NanPattern::ArithmeticNan => "nan:arithmetic".to_string(),
        NanPattern::Value(v) => fmt(v),
    }
}

fn heap_type_name(ht: &HeapType<'_>) -> Result<&'static str> {
    use AbstractHeapType::*;
    match ht {
        HeapType::Abstract { shared: false, ty } => Ok(match ty {
            Func => "funcref",
            Extern => "externref",
            Any => "anyref",
            Eq => "eqref",
            Array => "arrayref",
            Struct => "structref",
            I31 => "i31ref",
            Exn => "exnref",
            None => "nullref",
            NoFunc => "nullfuncref",
            NoExtern => "nullexternref",
            NoExn => "nullexnref",
            _ => bail!("unsupported abstract heap type"),
        }),
        _ => bail!("unsupported heap type in wast value"),
    }
}

fn v128_lanes<T: ToString>(lanes: &[T]) -> serde_json::Value {
    lanes
        .iter()
        .map(|l| serde_json::Value::from(l.to_string()))
        .collect::<Vec<_>>()
        .into()
}

fn v128_value(lane_type: &str, lanes: serde_json::Value) -> Value {
    Value {
        ty: "v128".to_string(),
        lane_type: Some(lane_type.to_string()),
        case: None,
        status: None,
        value: lanes,
    }
}

fn v128_const_value(v: V128Const) -> Value {
    use V128Const::*;
    match &v {
        I8x16(l) => v128_value("i8", v128_lanes(&l.map(|x| x as u8))),
        I16x8(l) => v128_value("i16", v128_lanes(&l.map(|x| x as u16))),
        I32x4(l) => v128_value("i32", v128_lanes(&l.map(|x| x as u32))),
        I64x2(l) => v128_value("i64", v128_lanes(&l.map(|x| x as u64))),
        F32x4(l) => v128_value("f32", v128_lanes(&l.map(|x| x.bits))),
        F64x2(l) => v128_value("f64", v128_lanes(&l.map(|x| x.bits))),
    }
}

fn v128_pattern_value(v: V128Pattern) -> Value {
    use V128Pattern::*;
    match v {
        I8x16(l) => v128_value("i8", v128_lanes(&l.map(|x| x as u8))),
        I16x8(l) => v128_value("i16", v128_lanes(&l.map(|x| x as u16))),
        I32x4(l) => v128_value("i32", v128_lanes(&l.map(|x| x as u32))),
        I64x2(l) => v128_value("i64", v128_lanes(&l.map(|x| x as u64))),
        F32x4(l) => v128_value(
            "f32",
            l.map(|x| nan_pattern_string(x, |f| f.bits.to_string()))
                .to_vec()
                .into(),
        ),
        F64x2(l) => v128_value(
            "f64",
            l.map(|x| nan_pattern_string(x, |f| f.bits.to_string()))
                .to_vec()
                .into(),
        ),
    }
}

/// Component-level value encoding; see harness/README.md.
fn component_value(v: WastVal<'_>) -> Result<Value> {
    Ok(match v {
        WastVal::Bool(b) => Value::simple("bool", b.to_string()),
        WastVal::U8(v) => Value::simple("u8", v.to_string()),
        WastVal::S8(v) => Value::simple("s8", v.to_string()),
        WastVal::U16(v) => Value::simple("u16", v.to_string()),
        WastVal::S16(v) => Value::simple("s16", v.to_string()),
        WastVal::U32(v) => Value::simple("u32", v.to_string()),
        WastVal::S32(v) => Value::simple("s32", v.to_string()),
        WastVal::U64(v) => Value::simple("u64", v.to_string()),
        WastVal::S64(v) => Value::simple("s64", v.to_string()),
        WastVal::F32(f) => Value::simple("f32", f.bits.to_string()),
        WastVal::F64(f) => Value::simple("f64", f.bits.to_string()),
        WastVal::Char(c) => Value::simple("char", c.to_string()),
        WastVal::String(s) => Value::simple("string", s.to_string()),
        WastVal::List(items) => Value::simple("list", nested(items)?),
        WastVal::Tuple(items) => Value::simple("tuple", nested(items)?),
        WastVal::Record(fields) => {
            let fields = fields
                .into_iter()
                .map(|(name, v)| {
                    Ok(serde_json::json!({
                        "name": name,
                        "value": serde_json::to_value(component_value(v)?)?,
                    }))
                })
                .collect::<Result<Vec<_>>>()?;
            Value::simple("record", fields)
        }
        WastVal::Variant(case, payload) => Value {
            ty: "variant".to_string(),
            lane_type: None,
            case: Some(case.to_string()),
            status: None,
            value: optional_nested(payload)?,
        },
        WastVal::Enum(case) => Value::simple("enum", case.to_string()),
        WastVal::Option(payload) => Value::simple("option", optional_nested(payload)?),
        WastVal::Result(r) => {
            let (status, payload) = match r {
                Ok(p) => ("ok", p),
                Err(p) => ("err", p),
            };
            Value {
                ty: "result".to_string(),
                lane_type: None,
                case: None,
                status: Some(status.to_string()),
                value: optional_nested(payload)?,
            }
        }
        WastVal::Flags(names) => Value::simple(
            "flags",
            names.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
        ),
    })
}

fn nested(items: Vec<WastVal<'_>>) -> Result<serde_json::Value> {
    let vals = items
        .into_iter()
        .map(component_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(serde_json::to_value(vals)?)
}

fn optional_nested(payload: Option<Box<WastVal<'_>>>) -> Result<serde_json::Value> {
    match payload {
        Some(v) => Ok(serde_json::to_value(component_value(*v)?)?),
        None => Ok(serde_json::Value::Null),
    }
}
