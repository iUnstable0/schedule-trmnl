import { handle } from '../dist/today.js';

export function GET(request) {
  return handle(request, process.env);
}
