#!/usr/bin/env node

const TOKEN = process.env.WEBEX_HELPER_ACCESS_TOKEN || '';

if (!TOKEN) {
  console.log(JSON.stringify({ok: false, error: 'WEBEX_HELPER_ACCESS_TOKEN is required'}));
  process.exit(1);
}

require('@webex/internal-plugin-metrics');
require('@webex/internal-plugin-mercury');
require('@webex/internal-plugin-conversation');

const WebexNode = require('webex-node');
const {
  deconstructHydraId,
  buildHydraRoomId,
  buildHydraMessageId,
} = require('@webex/common');

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out while waiting for ${label}`)), timeoutMs);
    }),
  ]);
}

function patchMetrics(webex) {
  const metrics = webex.internal?.newMetrics;
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

function summarizeThread(thread, fallbackCluster = 'us') {
  const cluster = thread.cluster || fallbackCluster;
  return {
    id: thread.id || null,
    conversationId: thread.conversationId || null,
    roomId: thread.conversationId ? buildHydraRoomId(thread.conversationId, cluster) : null,
    parentActivityId: thread.parentActivityId || null,
    parentMessageId: thread.parentActivityId ? buildHydraMessageId(thread.parentActivityId, cluster) : null,
    childType: thread.childType || '',
    childCount: Array.isArray(thread.childActivities) ? thread.childActivities.length : 0,
    childActivities: Array.isArray(thread.childActivities)
      ? thread.childActivities.map((item) => summarizeInternalActivity(item, cluster))
      : [],
  };
}

function ensureConversationServiceCatalog(webex, command) {
  const service = webex.internal?.services?.get('conversation', true);
  if (!service) {
    throw new Error(
      `Internal conversation service unavailable for ${command}. The SDK in this environment does not have the conversation service catalog loaded.`
    );
  }

  return service;
}

async function bootstrapConversationRuntime(webex, command, timeoutMs) {
  await withTimeout(
    webex.internal.services.waitForCatalog('postauth'),
    timeoutMs,
    'services.waitForCatalog(postauth)'
  );
  ensureConversationServiceCatalog(webex, command);
  await withTimeout(webex.internal.mercury.connect(), timeoutMs, 'mercury.connect()');
  ensureConversationServiceCatalog(webex, command);
}

async function resolveReactionParentActivity(webex, conversation, messageId, timeoutMs, activitiesLimit = 200) {
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

async function main() {
  const command = process.argv[2] || '';
  const payload = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const timeoutMs = Number(payload.timeoutMs || 30000);
  const webex = WebexNode.init({credentials: {access_token: TOKEN}});
  patchMetrics(webex);

  try {
    if (command === 'list_rooms_with_read_status') {
      const result = await withTimeout(
        webex.rooms.listWithReadStatus(Number(payload.maxRecent || 0)),
        timeoutMs,
        'rooms.listWithReadStatus()'
      );
      const items = result.items || result;
      console.log(JSON.stringify({ok: true, result: {count: items.length, rooms: items.map(summarizeReadRoom)}}));
      return;
    }

    if (command === 'get_room_with_read_status') {
      const result = await withTimeout(
        webex.rooms.getWithReadStatus(payload.roomId),
        timeoutMs,
        'rooms.getWithReadStatus()'
      );
      console.log(JSON.stringify({ok: true, result: summarizeReadRoom(result)}));
      return;
    }

    if (command === 'mark_message_seen') {
      const result = await withTimeout(
        webex.memberships.updateLastSeen({id: payload.messageId, roomId: payload.roomId}),
        timeoutMs,
        'memberships.updateLastSeen()'
      );
      console.log(JSON.stringify({ok: true, result: summarizeSeenUpdate(result)}));
      return;
    }

    if (command === 'update_typing_status') {
      await bootstrapConversationRuntime(webex, command, timeoutMs);
      const conversation = toInternalConversationRef(payload.roomId);
      await withTimeout(
        webex.internal.conversation.updateTypingStatus(conversation, {
          typing: Boolean(payload.typing),
        }),
        timeoutMs,
        'conversation.updateTypingStatus()'
      );
      console.log(JSON.stringify({ok: true, result: {roomId: payload.roomId, typing: Boolean(payload.typing)}}));
      return;
    }

    if (command === 'list_threads') {
      await bootstrapConversationRuntime(webex, command, timeoutMs);
      const allThreads = await withTimeout(
        webex.internal.conversation.listThreads(),
        timeoutMs,
        'conversation.listThreads()'
      );
      const room = payload.roomId ? toInternalConversationRef(payload.roomId) : null;
      const filtered = room
        ? allThreads.filter((item) => item.conversationId === room.id)
        : allThreads;
      const limited = filtered.slice(0, Number(payload.maxResults || 20));
      console.log(
        JSON.stringify({
          ok: true,
          result: {
            count: limited.length,
            threads: limited.map((item) => summarizeThread(item, room?.cluster || 'us')),
          },
        })
      );
      return;
    }

    if (command === 'add_reaction') {
      await bootstrapConversationRuntime(webex, command, timeoutMs);
      const conversation = toInternalConversationRef(payload.roomId);
      const cluster = conversation.cluster;
      const parentActivity = await resolveReactionParentActivity(
        webex,
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
      console.log(JSON.stringify({ok: true, result: summarizeInternalActivity(result, cluster)}));
      return;
    }

    if (command === 'delete_reaction') {
      await bootstrapConversationRuntime(webex, command, timeoutMs);
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
      console.log(JSON.stringify({ok: true, result: summarizeInternalActivity(result, cluster)}));
      return;
    }

    if (command === 'set_conversation_state') {
      await bootstrapConversationRuntime(webex, command, timeoutMs);
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
      console.log(JSON.stringify({ok: true, result: summarizeInternalActivity(result, cluster)}));
      return;
    }

    console.log(JSON.stringify({ok: false, error: `Unknown SDK helper command: ${command}`}));
    process.exitCode = 1;
    return;
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error: error?.message || String(error),
        detail: error?.stack || '',
      })
    );
    process.exitCode = 1;
    return;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

main();
