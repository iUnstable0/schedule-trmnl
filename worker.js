import { handle } from './dist/today.js';

export default {
  fetch: (request, env) => handle(request, env),
};
