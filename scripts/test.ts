import { Glob } from "bun";
const files = Array.from(new Glob("**/*.test.ts").scanSync({ cwd: new URL("..", import.meta.url).pathname }))
  .filter(path => !path.startsWith("node_modules/")).sort();
for (const file of files) {
  const child = Bun.spawn([process.execPath, "test", "./" + file, "--timeout", "30000"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited) process.exit(1);
}
