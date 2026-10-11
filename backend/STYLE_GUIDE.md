# Backend style guide

- Use the prelude `Result` for fallible returns. Write the error type in each
  signature, for example `Result<T, io::Error>` after importing `std::io`.
  Do not use a specialized `Result` alias. Import items from `std` instead of
  writing `std::` paths inline.
- Within a file, place every definition before its first use.
- Separate adjacent definitions or large code blocks with one blank line, including methods and
  associated types. Keep documentation and attributes attached to their definition.
- Do not panic in production code. Return errors for failures instead of using
  `unwrap`, `expect`, or panic macros. Define custom errors as `thiserror` enums
  in an `errors.rs` file scoped to the relevant module or crate.
- Prefer end-to-end tests over unit tests. Add a unit test only when it proves
  useful behavior that is difficult to model in an end-to-end test. Use `rstest`
  for all tests where it applies.
