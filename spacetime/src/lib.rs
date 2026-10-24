//! Mark-Et GTM: SpacetimeDB module.
//!
//! The engine calls a single reducer, `append_event`, once per pipeline step.
//! Every event is stored verbatim in `run_event` (the replayable log). The
//! reducer also materialises typed tables (runs, stages, graph, agents,
//! decisions, interviews, report sections, metrics) so the portal can
//! subscribe to exactly the slice it is showing.

use serde_json::Value;
use spacetimedb::{reducer, table, ReducerContext, Table};

#[table(accessor = run_event, public)]
pub struct RunEvent {
    #[primary_key]
    #[auto_inc]
    id: u64,
    #[index(btree)]
    run_id: String,
    seq: u64,
    ts: i64,
    kind: String,
    payload: String,
}

#[table(accessor = run, public)]
pub struct Run {
    #[primary_key]
    run_id: String,
    label: String,
    mode: String,
    status: String,
    started_at: i64,
    updated_at: i64,
    last_seq: u64,
    brief: String,
    backtest_case_id: String,
    cutoff: String,
    usage: String,
}

#[table(accessor = stage, public)]
pub struct Stage {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    stage: String,
    status: String,
    detail: String,
}

#[table(accessor = evidence, public)]
pub struct Evidence {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    source: String,
    json: String,
}

#[table(accessor = graph_node, public)]
pub struct GraphNode {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    node_id: String,
    kind: String,
    label: String,
    weight: f64,
    json: String,
}

#[table(accessor = graph_edge, public)]
pub struct GraphEdge {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    source: String,
    target: String,
    relation: String,
    weight: f64,
}

#[table(accessor = agent, public)]
pub struct Agent {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    agent_id: String,
    name: String,
    segment_id: String,
    backend: String,
    state: String,
    sentiment: f64,
    thinking: bool,
    persona: String,
}

#[table(accessor = agent_decision, public)]
pub struct AgentDecision {
    #[primary_key]
    #[auto_inc]
    id: u64,
    #[index(btree)]
    run_id: String,
    round: u32,
    agent_id: String,
    state: String,
    comment: String,
    json: String,
}

#[table(accessor = agent_message, public)]
pub struct AgentMessage {
    #[primary_key]
    #[auto_inc]
    id: u64,
    #[index(btree)]
    run_id: String,
    round: u32,
    from_agent: String,
    to_agent: String,
    text: String,
    sentiment: f64,
}

#[table(accessor = interview, public)]
pub struct Interview {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    agent_id: String,
    qa: String,
    done: bool,
    json: String,
}

#[table(accessor = report_section, public)]
pub struct ReportSection {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    section_id: String,
    title: String,
    order: u32,
    text: String,
    done: bool,
}

/// Singleton-per-run JSON blobs: bass fit, finance, backtest, adoption series.
#[table(accessor = metric, public)]
pub struct Metric {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    name: String,
    json: String,
}

fn k(run_id: &str, id: &str) -> String {
    format!("{run_id}/{id}")
}

fn s(v: &Value, path: &str) -> String {
    v.pointer(path).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

fn f(v: &Value, path: &str) -> f64 {
    v.pointer(path).and_then(|x| x.as_f64()).unwrap_or_default()
}

fn put_metric(ctx: &ReducerContext, run_id: &str, name: &str, json: String) {
    let key = k(run_id, name);
    let row = Metric { key: key.clone(), run_id: run_id.to_string(), name: name.to_string(), json };
    if ctx.db.metric().key().find(&key).is_some() {
        ctx.db.metric().key().update(row);
    } else {
        ctx.db.metric().insert(row);
    }
}

#[reducer]
pub fn append_event(ctx: &ReducerContext, run_id: String, seq: u64, ts: i64, kind: String, payload: String) -> Result<(), String> {
    let e: Value = serde_json::from_str(&payload).map_err(|err| format!("bad payload: {err}"))?;
    ctx.db.run_event().insert(RunEvent { id: 0, run_id: run_id.clone(), seq, ts, kind: kind.clone(), payload: payload.clone() });

    if let Some(mut r) = ctx.db.run().run_id().find(&run_id) {
        r.last_seq = seq;
        r.updated_at = ts;
        ctx.db.run().run_id().update(r);
    }

    match kind.as_str() {
        "run.started" => {
            // A re-run with the same id starts from a clean slate.
            clear_run(ctx, &run_id);
            ctx.db.run_event().insert(RunEvent { id: 0, run_id: run_id.clone(), seq, ts, kind: kind.clone(), payload });
            let row = Run {
                run_id: run_id.clone(),
                label: s(&e, "/label"),
                mode: s(&e, "/mode"),
                status: "running".into(),
                started_at: ts,
                updated_at: ts,
                last_seq: seq,
                brief: e.get("brief").map(|b| b.to_string()).unwrap_or_default(),
                backtest_case_id: s(&e, "/backtestCaseId"),
                cutoff: s(&e, "/cutoff"),
                usage: String::new(),
            };
            if ctx.db.run().run_id().find(&run_id).is_some() {
                ctx.db.run().run_id().update(row);
            } else {
                ctx.db.run().insert(row);
            }
        }
        "stage" => {
            let key = k(&run_id, &s(&e, "/stage"));
            let row = Stage { key: key.clone(), run_id: run_id.clone(), stage: s(&e, "/stage"), status: s(&e, "/status"), detail: s(&e, "/detail") };
            if ctx.db.stage().key().find(&key).is_some() {
                ctx.db.stage().key().update(row);
            } else {
                ctx.db.stage().insert(row);
            }
        }
        "evidence.added" => {
            let item = &e["item"];
            ctx.db.evidence().insert(Evidence { key: k(&run_id, &s(item, "/id")), run_id: run_id.clone(), source: s(item, "/source"), json: item.to_string() });
        }
        "signal.added" | "anchor.added" => {
            let (field, prefix) = if kind == "signal.added" { ("signal", "signal") } else { ("anchor", "anchor") };
            let item = &e[field];
            ctx.db.evidence().insert(Evidence { key: k(&run_id, &s(item, "/id")), run_id: run_id.clone(), source: prefix.into(), json: item.to_string() });
        }
        "graph.node" => {
            let n = &e["node"];
            let key = k(&run_id, &s(n, "/id"));
            let row = GraphNode { key: key.clone(), run_id: run_id.clone(), node_id: s(n, "/id"), kind: s(n, "/kind"), label: s(n, "/label"), weight: f(n, "/weight"), json: n.to_string() };
            if ctx.db.graph_node().key().find(&key).is_some() {
                ctx.db.graph_node().key().update(row);
            } else {
                ctx.db.graph_node().insert(row);
            }
        }
        "graph.edge" => {
            let ed = &e["edge"];
            ctx.db.graph_edge().insert(GraphEdge {
                key: k(&run_id, &s(ed, "/id")),
                run_id: run_id.clone(),
                source: s(ed, "/source"),
                target: s(ed, "/target"),
                relation: s(ed, "/relation"),
                weight: f(ed, "/weight"),
            });
        }
        "agent.created" => {
            let p = &e["persona"];
            ctx.db.agent().insert(Agent {
                key: k(&run_id, &s(p, "/id")),
                run_id: run_id.clone(),
                agent_id: s(p, "/id"),
                name: s(p, "/name"),
                segment_id: s(p, "/segmentId"),
                backend: s(p, "/backend"),
                state: "unaware".into(),
                sentiment: 0.0,
                thinking: false,
                persona: p.to_string(),
            });
        }
        "agent.thinking" => {
            if let Some(mut a) = ctx.db.agent().key().find(&k(&run_id, &s(&e, "/agentId"))) {
                a.thinking = true;
                ctx.db.agent().key().update(a);
            }
        }
        "agent.decision" => {
            let d = &e["decision"];
            let agent_id = s(d, "/agentId");
            if let Some(mut a) = ctx.db.agent().key().find(&k(&run_id, &agent_id)) {
                a.thinking = false;
                a.state = s(d, "/state");
                a.sentiment = f(d, "/sentiment");
                a.backend = s(d, "/backend");
                ctx.db.agent().key().update(a);
            }
            ctx.db.agent_decision().insert(AgentDecision {
                id: 0,
                run_id: run_id.clone(),
                round: f(d, "/round") as u32,
                agent_id,
                state: s(d, "/state"),
                comment: s(d, "/comment"),
                json: d.to_string(),
            });
        }
        "agent.message" => {
            let m = &e["message"];
            ctx.db.agent_message().insert(AgentMessage {
                id: 0,
                run_id: run_id.clone(),
                round: f(m, "/round") as u32,
                from_agent: s(m, "/from"),
                to_agent: s(m, "/to"),
                text: s(m, "/text"),
                sentiment: f(m, "/sentiment"),
            });
        }
        "round.completed" => put_metric(ctx, &run_id, &format!("round_{}", f(&e, "/summary/round") as u32), e["summary"].to_string()),
        "adoption.point" => put_metric(ctx, &run_id, &format!("adoption_{}", f(&e, "/point/month") as u32), e["point"].to_string()),
        "bass.fit" => put_metric(ctx, &run_id, "bass", e["fit"].to_string()),
        "finance.computed" => put_metric(ctx, &run_id, "finance", e["finance"].to_string()),
        "backtest.result" => put_metric(ctx, &run_id, "backtest", e["result"].to_string()),
        "market_backtest.row" => put_metric(ctx, &run_id, &format!("market_{}", s(&e, "/row/signalId")), e["row"].to_string()),
        "interview.started" => {
            let agent_id = s(&e, "/agentId");
            ctx.db.interview().insert(Interview { key: k(&run_id, &agent_id), run_id: run_id.clone(), agent_id, qa: "[]".into(), done: false, json: String::new() });
        }
        "interview.answer" => {
            if let Some(mut iv) = ctx.db.interview().key().find(&k(&run_id, &s(&e, "/agentId"))) {
                let mut qa: Vec<Value> = serde_json::from_str(&iv.qa).unwrap_or_default();
                qa.push(serde_json::json!({ "question": e["question"], "answer": e["answer"] }));
                iv.qa = Value::Array(qa).to_string();
                ctx.db.interview().key().update(iv);
            }
        }
        "interview.completed" => {
            let iv_json = &e["interview"];
            if let Some(mut iv) = ctx.db.interview().key().find(&k(&run_id, &s(iv_json, "/agentId"))) {
                iv.done = true;
                iv.qa = iv_json["qa"].to_string();
                iv.json = iv_json.to_string();
                ctx.db.interview().key().update(iv);
            }
        }
        "report.section" => {
            ctx.db.report_section().insert(ReportSection {
                key: k(&run_id, &s(&e, "/id")),
                run_id: run_id.clone(),
                section_id: s(&e, "/id"),
                title: s(&e, "/title"),
                order: f(&e, "/order") as u32,
                text: String::new(),
                done: false,
            });
        }
        "report.delta" => {
            if let Some(mut sec) = ctx.db.report_section().key().find(&k(&run_id, &s(&e, "/id"))) {
                sec.text.push_str(&s(&e, "/text"));
                ctx.db.report_section().key().update(sec);
            }
        }
        "report.section.done" => {
            if let Some(mut sec) = ctx.db.report_section().key().find(&k(&run_id, &s(&e, "/id"))) {
                sec.done = true;
                ctx.db.report_section().key().update(sec);
            }
        }
        "run.completed" => {
            if let Some(mut r) = ctx.db.run().run_id().find(&run_id) {
                r.status = s(&e, "/status");
                r.usage = e.get("usage").map(|u| u.to_string()).unwrap_or_default();
                ctx.db.run().run_id().update(r);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Deletes every row belonging to a run (used when a run id is reused).
#[reducer]
pub fn delete_run(ctx: &ReducerContext, run_id: String) {
    clear_run(ctx, &run_id);
    ctx.db.run().run_id().delete(&run_id);
}

fn clear_run(ctx: &ReducerContext, run_id: &str) {
    let rid = run_id.to_string();
    for r in ctx.db.run_event().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.run_event().id().delete(&r.id);
    }
    for r in ctx.db.stage().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.stage().key().delete(&r.key);
    }
    for r in ctx.db.evidence().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.evidence().key().delete(&r.key);
    }
    for r in ctx.db.graph_node().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.graph_node().key().delete(&r.key);
    }
    for r in ctx.db.graph_edge().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.graph_edge().key().delete(&r.key);
    }
    for r in ctx.db.agent().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.agent().key().delete(&r.key);
    }
    for r in ctx.db.agent_decision().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.agent_decision().id().delete(&r.id);
    }
    for r in ctx.db.agent_message().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.agent_message().id().delete(&r.id);
    }
    for r in ctx.db.interview().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.interview().key().delete(&r.key);
    }
    for r in ctx.db.report_section().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.report_section().key().delete(&r.key);
    }
    for r in ctx.db.metric().run_id().filter(&rid).collect::<Vec<_>>() {
        ctx.db.metric().key().delete(&r.key);
    }
}
