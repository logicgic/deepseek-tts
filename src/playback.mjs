import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

// PlaySync keeps the queue occupied until playback ends; no player window opens.
export async function playWav(wav, signal) {
  if (process.platform !== 'win32') return 'unsupported';
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), 'deepseek-voice-'));
  try {
    const file = path.join(directory, 'speech.wav');
    await writeFile(file, wav);
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $player = New-Object System.Media.SoundPlayer; try { $player.SoundLocation = $env:DS_PLAYBACK_FILE; $player.Load(); $player.PlaySync() } finally { $player.Dispose() }",
    ], { windowsHide: true, signal, timeout: 300_000, env: { ...process.env, DS_PLAYBACK_FILE: file } });
    return 'played';
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
