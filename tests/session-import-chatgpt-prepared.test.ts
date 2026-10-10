import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { prepareChatGptSource, importChatGptConversation, type ImportedChatGptConversation } from '../src/session/import/chatgpt.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const make = (i: number) => ({
  id: `c-${i}`,
  title: `Title ${i}`,
  current_node: 'answer',
  mapping: {
    root: {
      parent: null,
      message: null
    },
    user: {
      parent: 'root',
      message: {
        id: `u-${i}`,
        author: {
          role: 'user'
        },
        create_time: 1700000000,
        content: {
          content_type: 'text',
          parts: [`Question ${i} ${'x'.repeat(2048)}`]
        }
      }
    },
    old: {
      parent: 'user',
      message: {
        id: `o-${i}`,
        author: {
          role: 'assistant'
        },
        content: {
          content_type: 'text',
          parts: ['Unselected branch']
        }
      }
    },
    hidden: {
      parent: 'user',
      message: {
        id: `h-${i}`,
        author: {
          role: 'assistant'
        },
        channel: 'analysis',
        content: {
          content_type: 'text',
          parts: ['Hidden analysis']
        }
      }
    },
    answer: {
      parent: 'hidden',
      message: {
        id: `a-${i}`,
        author: {
          role: 'assistant'
        },
        create_time: 1700000001,
        content: {
          content_type: 'multimodal_text',
          parts: [`Answer ${i}`, {
              content_type: 'image_asset_pointer',
              asset_pointer: 'synthetic-only'
            }]
        }
      }
    }
  }
});
function normalize(source: ImportedChatGptConversation): unknown {
  const ids = new Map<string, string>();
  return {
    ...source,
    events: source.events.map(event => {
      assert.ok(event.type === "user_message" || event.type === "agent_message" || event.type === "assistant_message");
      assert.ok(event.messageId);
      assert.equal(event.slotId, event.messageId);
      if (!ids.has(event.messageId))
        ids.set(event.messageId, `nav-${ids.size + 1}`);
      const parent = event.parentMessageId;
      if (parent !== undefined)
        assert.ok(ids.has(parent));
      return {
        ...event,
        messageId: ids.get(event.messageId),
        slotId: ids.get(event.slotId!),
        parentMessageId: parent === undefined ? undefined : ids.get(parent)
      };
    })
  };
}
function oracle(i: number): unknown {
  const source = (record: number, messageId: string, parentMessageId: string) => ({
    format: 'chatgpt',
    conversationId: `c-${i}`,
    record,
    messageId,
    parentMessageId
  });
  const user = {
    messageId: 'nav-1',
    slotId: 'nav-1',
    parentMessageId: undefined,
    time: '2023-11-14T22:13:20.000Z',
    importSource: source(2, `u-${i}`, 'root')
  };
  const answer = {
    messageId: 'nav-2',
    slotId: 'nav-2',
    parentMessageId: 'nav-1',
    time: '2023-11-14T22:13:21.000Z',
    importSource: source(5, `a-${i}`, 'hidden')
  };
  return {
    events: [{
        type: 'user_message',
        ...user,
        content: `Question ${i} ${'x'.repeat(2048)}`
      }, {
        type: 'agent_message',
        ...answer,
        message: {
          role: 'assistant',
          content: [{
              type: 'text',
              text: `Answer ${i}`
            }]
        }
      }, {
        type: 'assistant_message',
        ...answer,
        content: `Answer ${i}`
      }],
    sourceConversationId: `c-${i}`,
    sourceTitle: `Title ${i}`,
    skippedContentCount: 2,
    skippedContentIssues: [{
        messageId: `h-${i}`,
        reason: 'hidden-message',
        count: 1
      }, {
        messageId: `a-${i}`,
        reason: 'unsupported-content',
        count: 1
      }]
  };
}
const oldParse = JSON.parse, oldRandom = crypto.randomBytes;
let parses = 0, identities = 0;
const raw = JSON.stringify([make(0), make(1)]);
try {
  JSON.parse = ((input: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (input === raw)
      parses++;
    return oldParse(input, reviver);
  }) as typeof JSON.parse;
  crypto.randomBytes = new Proxy(oldRandom, {
    apply(target, receiver, args) {
      identities++;
      return Reflect.apply(target, receiver, args);
    }
  });
  syncBuiltinESMExports();
  const prepared = prepareChatGptSource(raw, 'synthetic');
  assert.equal(prepared.list().length, 2);
  const metadata = [...prepared.records(hash)];
  assert.equal(metadata.length, 2);
  assert.equal(identities, 0);
  assert.deepEqual(normalize(prepared.importConversation('c-1')), oracle(1));
  assert.equal(parses, 1);
  assert.equal(identities, 2);
  assert.deepEqual(normalize(prepared.importConversation('c-0')), oracle(0));
  assert.equal(parses, 1);
  assert.equal(identities, 4);
  assert.deepEqual(normalize(importChatGptConversation(raw, 'synthetic', 'c-0')), oracle(0));
  assert.equal(parses, 2);
  assert.equal(identities, 6);
}
finally {
  JSON.parse = oldParse;
  crypto.randomBytes = oldRandom;
  syncBuiltinESMExports();
}
const bad = {
  ...make(1),
  current_node: 'missing'
};
const prepared = prepareChatGptSource(JSON.stringify([bad, make(0)]), 'synthetic');
assert.ok(prepared.list()[0]?.importError);
assert.deepEqual(normalize(prepared.importConversation('c-0')), oracle(0));
assert.throws(() => prepared.importConversation('c-1'), /current_node/u);
assert.throws(() => prepareChatGptSource(JSON.stringify([make(0), make(0)]), 'synthetic'), /ID 重复/u);
assert.throws(() => prepareChatGptSource(JSON.stringify([{
    ...make(0),
    id: 'source-record:2'
  }, {
    ...make(1),
    id: undefined
  }]), 'synthetic'), /ID 重复/u);
const anonymous = prepareChatGptSource(JSON.stringify([bad, {
    ...make(0),
    id: undefined
  }]), 'synthetic');
assert.equal(anonymous.list()[1]?.id, 'source-record:2');
assert.equal(anonymous.importConversation('source-record:2').sourceConversationId, undefined);
const first = prepared.importConversation('c-0');
const before = normalize(first);
prepared.importConversation('c-0');
assert.deepEqual(normalize(first), before);
// The service checks its display cap before invoking each lazy record hash.
const capRecords = Array.from({
  length: 257
}, (_, i) => make(i));
let digestCalls = 0;
const capped = prepareChatGptSource(JSON.stringify(capRecords), 'synthetic');
let displayed = 0;
for (const entry of capped.records(serialized => {
  digestCalls++;
  return createHash('sha256').update(serialized).digest('hex');
})) {
  if (displayed >= 256)
    break;
  assert.equal(entry.contentHash(), hash(capRecords[displayed]));
  displayed++;
}
assert.equal(displayed, 256);
assert.equal(digestCalls, 256);
// Serialization of an undisplayed very deep record must not occur.
const deepRaw = JSON.stringify(capRecords.slice(0, 256)).slice(0, -1) + ',{"id":"deep","mapping":{},"extra":' + '['.repeat(15000) + '0' + ']'.repeat(15000) + '}]';
const deep = prepareChatGptSource(deepRaw, 'synthetic');
let limited = 0;
for (const entry of deep.records(serialized => createHash('sha256').update(serialized).digest('hex'))) {
  if (limited >= 256)
    break;
  entry.contentHash();
  limited++;
}
assert.equal(limited, 256);
