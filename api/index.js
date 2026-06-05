import { handleRequest } from '../lib/app.js';

export default async function handler(req, res) {
  await handleRequest(req, res);
}
