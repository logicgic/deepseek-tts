import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CookieJar } from 'tough-cookie';
import { downloadPcm, wavFromPcm } from '../src/audio.mjs';

const frame = (seq, samples = [100, -200]) => {
  const bytes = Buffer.alloc(4 + samples.length * 2);
  bytes.writeUInt32BE(seq);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 4 + index * 2));
  return bytes;
};

async function upstream(t, connected) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  wss.on('connection', (socket, request) => connected(socket, new URL(request.url, 'http://localhost')));
  return {
    baseUrl: `http://127.0.0.1:${wss.address().port}`,
    session: { headers: {}, jar: new CookieJar() },
    json: async () => ({ ticket: 'synthetic-test-ticket' }),
  };
}

test('downloads contiguous PCM, deduplicates identical frames and writes exact WAV header', async (t) => {
  const http = await upstream(t, (socket, url) => {
    assert.equal(url.searchParams.get('format'), 'pcm');
    assert.equal(url.searchParams.get('message_id'), '2');
    socket.send(JSON.stringify({ event: 'ready', audio_id: 'synthetic-audio', format: 'pcm' }));
    socket.send(frame(0)); socket.send(frame(0)); socket.send(frame(1, [300, -400]));
    socket.send(JSON.stringify({ event: 'finish', code: 0 }));
  });
  const { pcm, frames } = await downloadPcm(http, { sessionId: 'synthetic-chat', messageId: 2 });
  assert.equal(frames, 2); assert.equal(pcm.length, 8);
  const wav = wavFromPcm(pcm);
  assert.equal(wav.length, 52); assert.equal(wav.readUInt32LE(4), 44);
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 8); assert.equal(wav.readInt16LE(46), -200);
});

for (const [name, send, code] of [
  ['missing frame', (s) => { s.send(frame(0)); s.send(frame(2)); }, 'AUDIO_GAP'],
  ['conflicting duplicate', (s) => { s.send(frame(0)); s.send(frame(0, [9])); }, 'AUDIO_PROTOCOL'],
  ['odd PCM payload', (s) => s.send(Buffer.from([0, 0, 0, 0, 1])), 'AUDIO_PROTOCOL'],
  ['close without finish', (s) => { s.send(frame(0)); s.close(); }, 'AUDIO_INTERRUPTED'],
  ['quota rejection', (s) => s.send(JSON.stringify({ event: 'finish', code: 4 })), 'TTS_QUOTA'],
  ['empty success', (s) => s.send(JSON.stringify({ event: 'finish', code: 0 })), 'AUDIO_EMPTY'],
]) {
  test(`rejects ${name} without returning a partial WAV`, async (t) => {
    const http = await upstream(t, (socket) => {
      socket.send(JSON.stringify({ event: 'ready', audio_id: 'synthetic-audio', format: 'pcm' }));
      send(socket);
    });
    await assert.rejects(downloadPcm(http, { sessionId: 'synthetic', messageId: 2, idleMs: 1000 }), { code });
  });
}

test('Opus cannot be accidentally wrapped in a PCM WAV file', async (t) => {
  const http = await upstream(t, (socket) => socket.send(JSON.stringify({ event: 'ready', audio_id: 'synthetic', format: 'opus' })));
  await assert.rejects(downloadPcm(http, { sessionId: 'synthetic', messageId: 2 }), { code: 'AUDIO_FORMAT' });
});

test('ACK reports reception separately from playback, and timeout releases socket', async (t) => {
  let ack;
  const http = await upstream(t, (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.event === 'ack') { ack = message; socket.send(JSON.stringify({ event: 'finish', code: 0 })); }
    });
    socket.send(JSON.stringify({ event: 'ready', audio_id: 'synthetic' })); socket.send(frame(0));
  });
  await downloadPcm(http, { sessionId: 'synthetic', messageId: 2, idleMs: 3000 });
  assert.equal(ack.received_seq, 1); assert.equal(ack.played_seq, 0);
});

test('stalled and cancelled downloads terminate instead of hanging', async (t) => {
  const http = await upstream(t, () => {});
  await assert.rejects(downloadPcm(http, { sessionId: 'synthetic', messageId: 2, idleMs: 30 }), { code: 'AUDIO_TIMEOUT' });
  await assert.rejects(downloadPcm(http, { sessionId: 'synthetic', messageId: 2, signal: AbortSignal.timeout(30) }), { name: 'TimeoutError' });
});
