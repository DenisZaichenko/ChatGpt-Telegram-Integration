import { hash } from "@node-rs/argon2";

const secret = process.argv[2];
if (!secret || secret.length < 12) {
  process.stderr.write("Usage: pnpm hash-pairing '<random-code-at-least-12-characters>'\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${await hash(secret)}\n`);
}
