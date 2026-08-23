const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { headers: JSON_HEADERS, status });
}

export function emptyJsonResponse(
  status: number,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(JSON_HEADERS);
  new Headers(headers).forEach((value, key) => {
    responseHeaders.set(key, value);
  });
  return new Response(null, {
    headers: responseHeaders,
    status,
  });
}

export function problemResponse(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(JSON_HEADERS);
  new Headers(headers).forEach((value, key) => {
    responseHeaders.set(key, value);
  });
  return Response.json(
    { error: { code, message } },
    { headers: responseHeaders, status },
  );
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return problemResponse(
    405,
    "method-not-allowed",
    "The requested method is not allowed for this resource.",
    { Allow: allowed.join(", ") },
  );
}
