#!/usr/bin/env node

const readline = require('node:readline');

require('@webex/internal-plugin-metrics');
require('@webex/internal-plugin-mercury');
require('@webex/internal-plugin-conversation');

const WebexNode = require('webex-node');
const {
  deconstructHydraId,
  buildHydraMessageId,
} = require('@webex/common');

let webex = null;
let conversationRuntimeReady = false;
let initialized = false;
let queue = Promise.resolve();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out while waiting for ${label}`)), timeoutMs);
    }),
  ]);
}

function patchMetrics(instance) {
  const metrics = instance.internal?.newMetrics;
  if (!metrics) return;

  const callDiagnosticMetrics = metrics.callDiagnosticMetrics || {};
  metrics.callDiagnosticMetrics = {
    setDeviceInfo() {},
    setMercuryConnectedStatus() {},
    submitMQE() {},
    submitFeatureEvent() {
      return Promise.resolve();
    },
    submitClientEvent() {
      return Promise.resolve();
    },
    submitDelayedClientEvents() {
      return Promise.resolve();
    },
    submitDelayedClientFeatureEvents() {
      return Promise.resolve();
    },
    isServiceErrorExpected() {
      return false;
    },
    buildClientEventFetchRequestOptions() {
      return Promise.resolve({});
    },
    ...callDiagnosticMetrics,
  };
}

function summarizeReadRoom(room) {
  const lastActivity = room.lastActivityDate || room.lastActivity || null;
  const lastSeen = room.lastSeenDate || null;
  return {
    id: room.id,
    title: room.title || '',
    type: room.type || '',
    lastActivityDate: lastActivity,
    lastSeenDate: lastSeen,
    isUnread: Boolean(lastActivity && (!lastSeen || new Date(lastActivity) > new Date(lastSeen))),
  };
}

function summarizeSeenUpdate(result) {
  return {
    id: result.id,
    roomId: result.roomId,
    roomType: result.roomType || '',
    lastSeenId: result.lastSeenId || null,
    created: result.created || null,
  };
}

function toInternalConversationRef(roomId) {
  const parts = deconstructHydraId(roomId);
  return {
    id: parts.id,
    cluster: parts.cluster || 'us',
  };
}

function normalizeActivityId(value) {
  if (!value) return value;
  if (value.startsWith('Y2lzY29z')) {
    return deconstructHydraId(value).id;
  }
  return value;
}

function summarizeInternalActivity(activity, cluster = 'us') {
  const object = activity?.object || {};
  const parent = activity?.parent || {};
  return {
    id: activity?.id || null,
    hydraId: activity?.id ? buildHydraMessageId(activity.id, cluster) : null,
    verb: activity?.verb || '',
    published: activity?.published || null,
    objectType: object.objectType || '',
    displayName: object.displayName || object.content || '',
    parentId: parent.id || null,
    parentHydraId: parent.id ? buildHydraMessageId(parent.id, cluster) : null,
  };
}

function ensureConversationServiceCatalog(command) {
  const service = webex?.internal?.services?.get('conversation', true);
  if (!service) {
    throw new Error(
      `Internal conversation service unavailable for ${command}. The SDK in this environment does not have the conversation service catalog loaded.`
    );
  }

  return service;
}

async function bootstrapConversationRuntime(command, timeoutMs) {
  if (conversationRuntimeReady) {
    ensureConversationServiceCatalog(command);
    return;
  }

  await withTimeout(
    webex.internal.services.waitForCatalog('postauth'),
    timeoutMs,
    'services.waitForCatalog(postauth)'
  );
  ensureConversationServiceCatalog(command);
  await withTimeout(webex.internal.mercury.connect(), timeoutMs, 'mercury.connect()');
  ensureConversationServiceCatalog(command);
  conversationRuntimeReady = true;
}

async function resolveReactionParentActivity(conversation, messageId, timeoutMs, activitiesLimit = 200) {
  const normalizedMessageId = normalizeActivityId(messageId);
  const convo = await withTimeout(
    webex.internal.conversation.get(conversation, {
      activitiesLimit,
    }),
    timeoutMs,
    'conversation.get()'
  );
  const activities = convo?.activities?.items || [];
  const parent = activities.find((item) => item.id === normalizedMessageId);

  if (parent?.encryptionKeyUrl) {
    await withTimeout(
      webex.internal.encryption.getKey(parent.encryptionKeyUrl),
      timeoutMs,
      'encryption.getKey()'
    );
    return parent;
  }

  if (convo?.defaultActivityEncryptionKeyUrl) {
    await withTimeout(
      webex.internal.encryption.getKey(convo.defaultActivityEncryptionKeyUrl),
      timeoutMs,
      'encryption.getKey()'
    );
    return {
      id: normalizedMessageId,
      encryptionKeyUrl: convo.defaultActivityEncryptionKeyUrl,
    };
  }

  throw new Error(`Could not resolve encryption metadata for message ${messageId}.`);
}

function initialize(token) {
  webex = WebexNode.init({credentials: {access_token: token}});
  patchMetrics(webex);
  initialized = true;
  conversationRuntimeReady = false;
}

async function executeCommand(command, payload = {}) {
  if (!initialized || !webex) {
    throw new Error('SDK helper is not initialized.');
  }

  const timeoutMs = Number(payload.timeoutMs || 30000);

  if (command === 'list_rooms_with_read_status') {
    const result = await withTimeout(
      webex.rooms.listWithReadStatus(Number(payload.maxRecent || 0)),
      timeoutMs,
      'rooms.listWithReadStatus()'
    );
    const items = result.items || result;
    return {count: items.length, rooms: items.map(summarizeReadRoom)};
  }

  if (command === 'get_room_with_read_status') {
    const result = await withTimeout(
      webex.rooms.getWithReadStatus(payload.roomId),
      timeoutMs,
      'rooms.getWithReadStatus()'
    );
    return summarizeReadRoom(result);
  }

  if (command === 'mark_message_seen') {
    const result = await withTimeout(
      webex.memberships.updateLastSeen({id: payload.messageId, roomId: payload.roomId}),
      timeoutMs,
      'memberships.updateLastSeen()'
    );
    return summarizeSeenUpdate(result);
  }

  if (command === 'update_typing_status') {
    await bootstrapConversationRuntime(command, timeoutMs);
    const conversation = toInternalConversationRef(payload.roomId);
    await withTimeout(
      webex.internal.conversation.updateTypingStatus(conversation, {
        typing: Boolean(payload.typing),
      }),
      timeoutMs,
      'conversation.updateTypingStatus()'
    );
    return {roomId: payload.roomId, typing: Boolean(payload.typing)};
  }

  if (command === 'add_reaction') {
    await bootstrapConversationRuntime(command, timeoutMs);
    const conversation = toInternalConversationRef(payload.roomId);
    const cluster = conversation.cluster;
    const parentActivity = await resolveReactionParentActivity(
      conversation,
      payload.messageId,
      timeoutMs,
      Number(payload.activitiesLimit || 200)
    );
    const result = await withTimeout(
      webex.internal.conversation.addReaction(
        conversation,
        payload.reaction,
        parentActivity
      ),
      timeoutMs,
      'conversation.addReaction()'
    );
    return summarizeInternalActivity(result, cluster);
  }

  if (command === 'delete_reaction') {
    await bootstrapConversationRuntime(command, timeoutMs);
    const conversation = toInternalConversationRef(payload.roomId);
    const cluster = conversation.cluster;
    const result = await withTimeout(
      webex.internal.conversation.deleteReaction(
        conversation,
        normalizeActivityId(payload.reactionId)
      ),
      timeoutMs,
      'conversation.deleteReaction()'
    );
    return summarizeInternalActivity(result, cluster);
  }

  if (command === 'set_conversation_state') {
    await bootstrapConversationRuntime(command, timeoutMs);
    const conversation = toInternalConversationRef(payload.roomId);
    const cluster = conversation.cluster;
    const action = `${payload.action || ''}`;
    const allowed = new Set(['favorite', 'unfavorite', 'hide', 'unhide', 'mute', 'unmute']);
    if (!allowed.has(action)) {
      throw new Error(`Unsupported conversation state action: ${action}`);
    }
    const result = await withTimeout(
      webex.internal.conversation[action](conversation),
      timeoutMs,
      `conversation.${action}()`
    );
    return summarizeInternalActivity(result, cluster);
  }

  throw new Error(`Unknown SDK helper command: ${command}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  queue = queue
    .then(async () => {
      if (!line.trim()) return;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        send({type: 'response', id: null, ok: false, error: `Invalid helper input: ${error.message || String(error)}`});
        return;
      }

      if (message.type === 'init') {
        if (!message.token) {
          send({type: 'response', id: null, ok: false, error: 'Helper token is required'});
          return;
        }
        initialize(message.token);
        send({type: 'ready'});
        return;
      }

      if (message.type !== 'call') {
        send({type: 'response', id: message.id || null, ok: false, error: `Unknown helper message type: ${message.type || ''}`});
        return;
      }

      try {
        const result = await executeCommand(message.command, message.payload || {});
        send({type: 'response', id: message.id, ok: true, result});
      } catch (error) {
        send({
          type: 'response',
          id: message.id,
          ok: false,
          error: error?.message || String(error),
          detail: error?.stack || '',
        });
      }
    })
    .catch((error) => {
      send({type: 'response', id: null, ok: false, error: error?.message || String(error), detail: error?.stack || ''});
    });
});

rl.on('close', () => {
  process.exit(process.exitCode || 0);
});
