import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// В архив попадает проверенный dist и исходники именно этого коммита, а не рабочая папка.
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const releaseId = process.env.RELEASE_ID || `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${commit.slice(0, 8)}`;
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,79}$/.test(releaseId)) throw new Error('Неверная версия релиза');
mkdirSync('dist/downloads', { recursive: true });
mkdirSync('artifact', { recursive: true });
execFileSync('git', ['archive', '--format=zip', '--prefix=telegram-chat/', '-o', 'dist/downloads/telegram-chat-source.zip', commit]);
const sourceSha256 = createHash('sha256').update(readFileSync('dist/downloads/telegram-chat-source.zip')).digest('hex');
const marker = { releaseId, commit, builtAtUtc: new Date().toISOString(), sourceSha256 };
writeFileSync('dist/release.json', JSON.stringify(marker, null, 2) + '\n');
writeFileSync('dist/downloads/source.json', JSON.stringify({ commit, sha256: sourceSha256 }, null, 2) + '\n');
execFileSync('tar', ['-czf', 'artifact/release.tar.gz', '-C', 'dist', '.']);
const archiveSha256 = createHash('sha256').update(readFileSync('artifact/release.tar.gz')).digest('hex');
writeFileSync('artifact/manifest.json', JSON.stringify({ ...marker, archiveSha256 }, null, 2) + '\n');
console.log(`Сборка ${releaseId}; SHA-256 ${archiveSha256}`);
