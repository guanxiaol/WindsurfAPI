import { createHash } from 'crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function callerKeyFromRequest(req, apiKey = '') {
  if (apiKey) return `api:${sha256Hex(apiKey).slice(0, 32)}`;
  const sessionId = req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id'] || '';
  if (sessionId) return `session:${sha256Hex(sessionId).slice(0, 32)}`;
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  return `client:${sha256Hex(`${ip}\0${ua}`).slice(0, 32)}`;
}
