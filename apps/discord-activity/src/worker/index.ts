import type { Env } from "./env.js";
import { routeRequest } from "./router.js";

export { TableRoom } from "./durable-objects/table-room.js";
export type { AuthenticationMode, Env } from "./env.js";

const worker = {
  fetch(request: Request, env: Env): Promise<Response> {
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

export default worker;
