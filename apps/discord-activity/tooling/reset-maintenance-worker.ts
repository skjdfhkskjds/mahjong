export default {
  fetch(): Response {
    return new Response("Deployment in progress", {
      status: 503,
      headers: { "Retry-After": "60" },
    });
  },
};
