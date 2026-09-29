import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });
const publicBytes = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(publicJwk.x, 'base64url'),
  Buffer.from(publicJwk.y, 'base64url'),
]);

console.log('Созданы два ключа VAPID. Не отправляйте приватный ключ в чат и не добавляйте его в .env или GitHub.');
console.log(`Публичный (для GitHub Variables и .env): ${publicBytes.toString('base64url')}`);
console.log(`Приватный (только Supabase Edge Function Secret): ${privateJwk.d}`);
