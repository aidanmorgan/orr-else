import { Type } from "@earendil-works/pi-ai";
import { 
  TeammateEvent, 
  TeammateEventType, 
  createTeammateEventIdempotencyKey 
} from '../core/TeammateEvents.js';
import { Logger } from '../core/Logger.js';
import { ApiPath, BuiltInToolName, Component, EnvVars, Defaults, EventName, HttpHeader, HttpMethod } from '../constants/index.js';

const API_PORT = process.env[EnvVars.API_PORT] || Defaults.API_PORT;
const API_BASE = process.env[EnvVars.API_BASE] || `http://${Defaults.API_HOST}:${API_PORT}`;

async function apiRequest(path: string, method: string, body?: any) {
  Logger.debug(Component.SIGNALING, `API Request: ${method} ${path}`, { body });
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { [HttpHeader.CONTENT_TYPE]: HttpHeader.APPLICATION_JSON },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    Logger.error(Component.SIGNALING, `API Request failed: ${response.status}`, { path, text });
    throw new Error(`API Error: ${response.status} ${text}`);
  }
  if (!text || response.status === 204) return null;
  return JSON.parse(text);
}

function normalizeStatusToEventType(status: string): TeammateEventType {
  const upper = status.toUpperCase();
  if (upper === EventName.FAILURE) return TeammateEventType.STATE_FAILED;
  if (upper === EventName.BLOCKED) return TeammateEventType.STATE_BLOCKED;
  return TeammateEventType.STATE_TRANSITIONED;
}

export const signalingPlugin = {
  name: 'harness-signaling',
  tools: [
    {
      name: BuiltInToolName.SIGNAL_COMPLETION,
      description: 'Signal task completion or phase transition to the coordinator.',
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (event: TeammateEvent) => await apiRequest(ApiPath.SIGNAL, HttpMethod.POST, event)
    }
  ]
};
