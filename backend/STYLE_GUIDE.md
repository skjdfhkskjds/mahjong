# Backend style guide

- Use the prelude `Result` for fallible returns. Write the error type in each
  signature, for example `Result<T, io::Error>` after importing `std::io`.
  Do not use a specialized `Result` alias. Import items from `std` instead of
  writing `std::` paths inline.
