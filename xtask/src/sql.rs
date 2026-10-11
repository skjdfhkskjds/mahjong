use std::{
    env,
    error::Error,
    fs,
    io::{self, Write},
    ops::Range,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use syn::{LitStr, Token, Type, parse::Parser, spanned::Spanned, visit::Visit};

use crate::errors::TaskError;

const SQL_FORMATTER: &str = "sql-formatter@15.9.0";

pub(crate) const USAGE: &str = "Usage: cargo xtask format-sql [--write|--check]";

const PREPARE_USAGE: &str = "Usage: cargo xtask sqlx-prepare [--check]";

const SQL_MIGRATION_PATH: &str = "backend/crates/engine/src/storage/sqlite/migrations";

struct Query {
    literal: LitStr,
    range: Range<usize>,
    indent: String,
}

#[derive(Default)]
struct Queries {
    literals: Vec<(LitStr, usize)>,
    errors: Vec<syn::Error>,
}

impl<'ast> Visit<'ast> for Queries {
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        let segments: Vec<_> = node
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        let name = segments.last().map(String::as_str).unwrap_or_default();
        let is_sqlx = segments.len() == 1 || (segments.len() == 2 && segments[0] == "sqlx");
        let typed = matches!(name, "query_as" | "query_as_unchecked");

        if is_sqlx
            && (typed
                || matches!(
                    name,
                    "query" | "query_unchecked" | "query_scalar" | "query_scalar_unchecked"
                ))
        {
            let parser = |input: syn::parse::ParseStream<'_>| {
                if typed {
                    input.parse::<Type>()?;
                    input.parse::<Token![,]>()?;
                }

                let literal = input.parse::<LitStr>()?;
                if !input.is_empty() && !input.peek(Token![,]) {
                    return Err(input.error("SQL formatting requires a single string literal"));
                }

                input.parse::<proc_macro2::TokenStream>()?;
                Ok(literal)
            };

            match parser.parse2(node.tokens.clone()) {
                Ok(literal) => self
                    .literals
                    .push((literal, node.span().byte_range().start)),
                Err(error) => self.errors.push(error),
            }
        }

        syn::visit::visit_macro(self, node);
    }
}

fn queries(source: &str) -> Result<Vec<Query>, Box<dyn Error>> {
    let syntax = syn::parse_file(source)?;

    // syn removes these prefixes before assigning token spans.
    let prefix_len = if source.starts_with('\u{feff}') { 3 } else { 0 }
        + syntax.shebang.as_ref().map_or(0, String::len);

    let mut visitor = Queries::default();
    visitor.visit_file(&syntax);
    if let Some(error) = visitor.errors.into_iter().next() {
        return Err(format!("line {}: {error}", error.span().start().line).into());
    }

    visitor
        .literals
        .into_iter()
        .map(|(literal, start)| {
            let start = start + prefix_len;
            let span = literal.span().byte_range();
            let range = span.start + prefix_len..span.end + prefix_len;
            let line_start = source[..start].rfind('\n').map_or(0, |index| index + 1);
            let indent: String = source[line_start..start]
                .chars()
                .take_while(|c| *c == ' ' || *c == '\t')
                .collect();

            Ok(Query {
                literal,
                range,
                indent,
            })
        })
        .collect()
}

// Indent SQL layout without changing newlines inside quoted values or identifiers.
fn indent_sql(sql: &str, indent: &str) -> String {
    let mut result = String::new();
    let mut chars = sql.chars().peekable();
    let mut quote = None;
    let mut block_comment = false;
    let mut line_comment = false;
    let mut line_start = true;

    while let Some(ch) = chars.next() {
        if line_start && ch != '\n' && quote.is_none() && !block_comment {
            result.push_str(indent);
        }

        result.push(ch);
        line_start = ch == '\n';
        if line_start {
            line_comment = false;
            continue;
        }

        if line_comment {
            continue;
        }

        if block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                result.push('/');
                chars.next();
                block_comment = false;
            }
        } else if let Some(end) = quote {
            if ch == end {
                if end != ']' && chars.peek() == Some(&end) {
                    result.push(end);
                    chars.next();
                } else {
                    quote = None;
                }
            }
        } else {
            match (ch, chars.peek()) {
                ('-', Some('-')) => line_comment = true,
                ('/', Some('*')) => {
                    result.push('*');
                    chars.next();
                    block_comment = true;
                }
                ('\'' | '"' | '`', _) => quote = Some(ch),
                ('[', _) => quote = Some(']'),
                _ => {}
            }
        }
    }

    result
}

fn render_query(query: &Query, sql: &str) -> String {
    let mut hashes = String::from("#");

    while sql.contains(&format!("\"{hashes}")) {
        hashes.push('#');
    }

    let indent = &query.indent;
    let lines = indent_sql(sql.trim_end(), &format!("{indent}        "));

    format!("r{hashes}\"\n{lines}\n{indent}    \"{hashes}")
}

fn format_sql(root: &Path, sql: &str) -> Result<String, Box<dyn Error>> {
    let mut child = Command::new("npx")
        .args(["--yes", SQL_FORMATTER, "--config"])
        .arg(root.join("backend/.sql-formatter.json"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("could not run npx (install Node.js and npm): {error}"),
            )
        })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("formatter stdin unavailable"))?;

    // Feed input concurrently: large SQL files can otherwise fill both pipes.
    let input = sql.to_owned();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let output = child.wait_with_output()?;
    let written = writer
        .join()
        .map_err(|_| io::Error::other("formatter input thread failed"))?;
    if !output.status.success() {
        return Err(format!("{SQL_FORMATTER} failed with {}", output.status).into());
    }

    written?;
    Ok(String::from_utf8(output.stdout)?)
}

fn format_rust(root: &Path, source: &str) -> Result<String, Box<dyn Error>> {
    let mut replacements: Vec<(Range<usize>, String)> = Vec::new();

    for query in queries(source)? {
        let formatted = format_sql(root, &query.literal.value())?;
        replacements.push((query.range.clone(), render_query(&query, &formatted)));
    }

    replacements.sort_by_key(|(range, _)| range.start);
    let mut result = source.to_owned();

    for (range, replacement) in replacements.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    Ok(result)
}

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_files(&entry.path(), files)?;
        } else if kind.is_file()
            && matches!(
                entry.path().extension().and_then(|s| s.to_str()),
                Some("rs" | "sql")
            )
        {
            files.push(entry.path());
        }
    }

    Ok(())
}

fn run(root: &Path, check: bool) -> Result<(), Box<dyn Error>> {
    let mut files = Vec::new();
    collect_files(&root.join("backend/crates"), &mut files)?;
    files.sort();

    // Finish parsing/formatting everything before writing any source files.
    let mut changes = Vec::new();
    for path in files {
        let source = fs::read_to_string(&path)?;
        let result = if path.extension().is_some_and(|ext| ext == "sql") {
            format_sql(root, &source)
        } else {
            format_rust(root, &source)
        };
        let formatted = result.map_err(|error| format!("{}: {error}", path.display()))?;
        if formatted != source {
            changes.push((path, formatted));
        }
    }

    if check && !changes.is_empty() {
        let paths = changes
            .iter()
            .map(|(path, _)| {
                path.strip_prefix(root)
                    .map(|path| path.display().to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;

        return Err(format!("SQL formatting required:\n{}", paths.join("\n")).into());
    }

    for (path, formatted) in &changes {
        let relative = path.strip_prefix(root)?;
        fs::write(path, formatted)?;
        println!("Formatted {}", relative.display());
    }

    if !check
        && changes
            .iter()
            .any(|(path, _)| path.extension().is_some_and(|ext| ext == "rs"))
    {
        println!("Run cargo fmt --all, then cargo xtask sqlx-prepare to refresh SQLx metadata.");
    }

    Ok(())
}

pub(crate) fn format(check: bool) -> Result<(), TaskError> {
    let mode = if check { "--check" } else { "--write" };
    println!("Running SQL formatting {mode}");

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");

    run(&root, check)?;

    Ok(())
}

pub(crate) fn execute(args: &[String]) -> Result<(), TaskError> {
    if args == ["--help"] {
        println!("{USAGE}");
        return Ok(());
    }

    let check = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] | ["--write"] => false,
        ["--check"] => true,
        _ => return Err(TaskError::Usage(USAGE)),
    };

    format(check)
}

fn sqlx(root: &Path, database_url: &str, args: &[&str]) -> Result<(), TaskError> {
    let command = format!("cargo sqlx {}", args.join(" "));
    println!("Running {command}");

    let status = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .arg("sqlx")
        .args(args)
        .current_dir(root)
        .env("DATABASE_URL", database_url)
        .env("SQLX_OFFLINE", "false")
        .status()
        .map_err(|source| TaskError::Spawn {
            command: command.clone(),
            source,
        })?;

    if !status.success() {
        return Err(TaskError::Command { command, status });
    }

    Ok(())
}

pub(crate) fn prepare(check: bool) -> Result<(), TaskError> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let database = tempfile::tempdir().map_err(TaskError::TemporaryDatabase)?;
    let database_url = format!(
        "sqlite://{}",
        database.path().join("schema.sqlite").display()
    );

    sqlx(&root, &database_url, &["database", "create"])?;

    sqlx(
        &root,
        &database_url,
        &["migrate", "run", "--source", SQL_MIGRATION_PATH],
    )?;

    let mut args = vec!["prepare", "--workspace"];

    if check {
        args.push("--check");
    }

    args.extend(["--", "--all-targets", "--locked"]);
    sqlx(&root, &database_url, &args)?;

    Ok(())
}

pub(crate) fn execute_prepare(args: &[String]) -> Result<(), TaskError> {
    if args == ["--help"] || args == ["-h"] {
        println!("{PREPARE_USAGE}");
        return Ok(());
    }

    if args.is_empty() {
        prepare(false)
    } else if args == ["--check"] {
        prepare(true)
    } else {
        Err(TaskError::Usage(PREPARE_USAGE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case(r#"sqlx::query!("select ?", "do not format me")"#, "select ?")]
    #[case(
        r##"sqlx::query_as!(Row<A, B>, r#"select '🀄', ?"#, value)"##,
        "select '🀄', ?"
    )]
    #[case(
        r#"query_scalar!("select \"name\" from users")"#,
        "select \"name\" from users"
    )]
    fn finds_only_query_literal(
        #[case] expression: &str,
        #[case] expected: &str,
    ) -> Result<(), Box<dyn Error>> {
        let source = format!("fn main() {{ let _ = \"🀄\"; {expression}; }}");
        let found = queries(&source)?;

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].literal.value(), expected);
        let range = found[0].range.clone();
        assert_eq!(syn::parse_str::<LitStr>(&source[range])?.value(), expected);
        Ok(())
    }

    #[rstest]
    #[case("\u{feff}")]
    #[case("#!/usr/bin/env rust-script\n")]
    #[case("\u{feff}#!/usr/bin/env rust-script\n")]
    fn preserves_file_prefixes(#[case] prefix: &str) -> Result<(), Box<dyn Error>> {
        let source = format!("{prefix}fn main() {{ sqlx::query!(\"select 1\"); }}");
        let found = queries(&source)?;

        assert_eq!(&source[found[0].range.clone()], "\"select 1\"");
        let mut changed = source;

        changed.replace_range(
            found[0].range.clone(),
            &render_query(&found[0], "SELECT\n    1"),
        );

        assert!(changed.starts_with(prefix));
        assert_eq!(queries(&changed)?.len(), 1);
        Ok(())
    }

    #[rstest]
    #[case("SELECT\n    'first\nsecond'", "  SELECT\n      'first\nsecond'")]
    #[case("SELECT\n    'it''s\na value'", "  SELECT\n      'it''s\na value'")]
    #[case("SELECT\n    \"first\nsecond\"", "  SELECT\n      \"first\nsecond\"")]
    #[case("SELECT\n    [first\nsecond]", "  SELECT\n      [first\nsecond]")]
    #[case("-- don't quote\nSELECT 1", "  -- don't quote\n  SELECT 1")]
    #[case(
        "/* 'comment\nstill comment */\nSELECT 1",
        "  /* 'comment\nstill comment */\n  SELECT 1"
    )]
    fn indentation_preserves_quoted_content(#[case] sql: &str, #[case] expected: &str) {
        assert_eq!(indent_sql(sql, "  "), expected);
    }

    #[rstest]
    fn preserves_sql_and_surrounding_rust() -> Result<(), Box<dyn Error>> {
        let source = "fn main() {\n    sqlx::query!(\"select ?\", arg);\n}";
        let found = queries(source)?;
        let sql = "SELECT\n    'quote\"# and \\ slash',\n    ?\n";
        let replacement = render_query(&found[0], sql);
        let mut changed = source.to_owned();

        changed.replace_range(found[0].range.clone(), &replacement);

        assert!(changed.ends_with(", arg);\n}"));
        let reparsed = queries(&changed)?;
        let unindented = reparsed[0]
            .literal
            .value()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.strip_prefix("            ").unwrap_or(line).to_owned())
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(unindented, sql.trim_end());
        assert_eq!(render_query(&reparsed[0], sql), replacement);
        Ok(())
    }

    #[rstest]
    #[case("sqlx::query!(SQL)")]
    #[case("sqlx::query!(\"select \" + \"1\")")]
    fn rejects_unsupported_query_expressions(#[case] expression: &str) {
        assert!(queries(&format!("fn main() {{ {expression}; }}")).is_err());
    }

    #[rstest]
    fn ignores_files_and_unrelated_strings() -> Result<(), Box<dyn Error>> {
        assert!(
            queries(
                r#"fn main() {
            sqlx::query_file!("query.sql");
            other::query!("not SQL");
            let text = "sqlx::query!(not real code)";
        }"#
            )?
            .is_empty()
        );
        Ok(())
    }
}
