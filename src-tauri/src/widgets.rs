//! `loki://localhost/widgets/<desk>/<name>.js` — an agent-written `.tsx`/`.jsx`
//! widget, transpiled on request (oxc: TypeScript stripped, JSX → React automatic
//! runtime) with its bare imports rewritten to the app's shared modules, so a
//! widget uses the same React instance as the canvas. No bundler, no Vite.

use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{JsxOptions, JsxRuntime, TransformOptions, Transformer};

/// Bare specifiers a widget may import; anything else stays as written.
const SHARED: &[&str] = &["react", "react/jsx-runtime", "react-dom", "recharts", "@loki/kit"];

pub fn widgets_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("LOKI_WIDGETS_DIR") { return PathBuf::from(p); }
    crate::home_dir().join(".letta").join("loki").join("widgets")
}

/// Map a request path like `/widgets/<desk>/<name>.js` to the source file on disk.
pub fn source_for(request_path: &str, root: &Path) -> Option<PathBuf> {
    let rel = request_path.strip_prefix("/widgets/")?;
    let rel = percent_encoding::percent_decode_str(rel).decode_utf8().ok()?;
    // No way out of the root: `..`, a leading `/`, and on Windows a drive (`C:`) or a backslash, either of which
    // makes `root.join` replace the root rather than extend it.
    if rel.contains("..") || rel.starts_with('/') || (cfg!(windows) && (rel.contains(':') || rel.contains('\\'))) { return None; }
    let stem = rel.strip_suffix(".js")?;
    for ext in ["tsx", "jsx"] {
        let p = root.join(format!("{stem}.{ext}"));
        if p.is_file() { return Some(p); }
    }
    None
}

/// TSX/JSX → plain ESM with the React automatic runtime.
pub fn transpile(source: &str, path: &Path) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| e.to_string())?;
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let parse_errors = parsed.diagnostics.into_vec();
    if !parse_errors.is_empty() {
        return Err(parse_errors.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n"));
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    let mut options = TransformOptions::default();
    options.jsx = JsxOptions { runtime: JsxRuntime::Automatic, development: false, ..JsxOptions::default() };
    let result = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    let transform_errors = result.diagnostics.into_vec();
    if !transform_errors.is_empty() {
        return Err(transform_errors.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n"));
    }
    Ok(Codegen::new().build(&program).code)
}

/// Rewrite `import … from "<shared>"` into reads from `window.__lokiShared[...]`.
/// Handles default, named (with aliases) and namespace imports, one statement per line as codegen emits them.
pub fn rewrite_shared_imports(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    for line in code.lines() {
        let trimmed = line.trim_start();
        if let Some(rewritten) = rewrite_import_line(trimmed) {
            out.push_str(&rewritten);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

fn rewrite_import_line(line: &str) -> Option<String> {
    if !line.starts_with("import ") { return None; }
    let from = line.rfind(" from ")?;
    let spec = line[from + 6..].trim().trim_end_matches(';').trim_matches(|c| c == '"' || c == '\'');
    if !SHARED.contains(&spec) { return None; }
    let clause = line[7..from].trim();
    let table = format!("window.__lokiShared[{}]", serde_json::to_string(spec).ok()?);
    let mut stmts = vec![];
    let mut rest = clause;
    if let Some(ns) = rest.strip_prefix("* as ") {
        return Some(format!("const {} = {};", ns.trim(), table));
    }
    if let Some(brace) = rest.find('{') {
        let default_part = rest[..brace].trim().trim_end_matches(',').trim();
        if !default_part.is_empty() {
            stmts.push(format!("const {default_part} = {table}.default ?? {table};"));
        }
        let names = rest[brace + 1..rest.rfind('}')?].split(',').map(|n| n.trim()).filter(|n| !n.is_empty());
        let bindings: Vec<String> = names.map(|n| match n.split_once(" as ") { Some((a, b)) => format!("{}: {}", a.trim(), b.trim()), None => n.to_string() }).collect();
        if !bindings.is_empty() {
            stmts.push(format!("const {{ {} }} = {table};", bindings.join(", ")));
        }
        rest = "";
    }
    if !rest.is_empty() {
        stmts.push(format!("const {} = {table}.default ?? {table};", rest.trim()));
    }
    Some(stmts.join(" "))
}

/// Serve one request under the `loki` scheme.
pub fn respond(uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let cors = |b: tauri::http::response::Builder| b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").header(header::CACHE_CONTROL, "no-store");
    eprintln!("loki: widget request {uri_path}");
    let Some(src) = source_for(uri_path, &widgets_dir()) else {
        return cors(Response::builder().status(StatusCode::NOT_FOUND)).body(b"not a widget".to_vec()).unwrap();
    };
    let Ok(source) = std::fs::read_to_string(&src) else {
        return cors(Response::builder().status(StatusCode::NOT_FOUND)).body(b"unreadable".to_vec()).unwrap();
    };
    match transpile(&source, &src) {
        Ok(js) => cors(Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, "text/javascript; charset=utf-8"))
            .body(rewrite_shared_imports(&js).into_bytes())
            .unwrap(),
        Err(err) => {
            // Surface the compile error as a module that throws, so the frame shows it like a runtime error.
            let js = format!("throw new Error({});", serde_json::to_string(&format!("{}: {err}", src.display())).unwrap_or_default());
            cors(Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")).body(js.into_bytes()).unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_shared_imports_only() {
        let code = "import React, { useState, useEffect as ue } from \"react\";\nimport * as K from \"@loki/kit\";\nimport { jsx as _jsx } from \"react/jsx-runtime\";\nimport x from \"./local.js\";\n";
        let out = rewrite_shared_imports(code);
        assert!(out.contains("const React = window.__lokiShared[\"react\"].default ?? window.__lokiShared[\"react\"];"));
        assert!(out.contains("const { useState, useEffect: ue } = window.__lokiShared[\"react\"];"));
        assert!(out.contains("const K = window.__lokiShared[\"@loki/kit\"];"));
        assert!(out.contains("const { jsx: _jsx } = window.__lokiShared[\"react/jsx-runtime\"];"));
        assert!(out.contains("import x from \"./local.js\";"));
    }

    #[test]
    fn transpiles_tsx_to_automatic_runtime() {
        let src = "import { InfoCard } from \"@loki/kit\";\nexport default function W({ data }: { data: { n: number } }) { return <InfoCard data={data} />; }\n";
        let js = transpile(src, Path::new("/tmp/w.tsx")).unwrap();
        assert!(js.contains("react/jsx-runtime"), "{js}");
        assert!(!js.contains(": {"), "types stripped: {js}");
    }
}
